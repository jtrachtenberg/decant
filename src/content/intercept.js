// Decant — content script: intercept → convert → substitute.
//
// Listens for file-attach events on claude.ai, runs each file through the
// converter — the routing table decides its fate (default: PDF → Markdown,
// everything else passthrough) — and substitutes the result into the upload
// before Claude sees it.
//
// Four attach paths:
//   1. <input type="file"> change   (file-picker / paperclip button)
//   2. drop                          (drag-and-drop onto the composer)
//   3. paste                         (file pasted from clipboard)
//   4. detached picker               (createElement'd input never in the DOM —
//                                     relayed by the MAIN-world shim, ADR 0019)
//
// Listeners are bound to `window` in the capture phase at document_start, ahead
// of the site's own handlers. We block the original event synchronously, then
// convert asynchronously and re-inject through the hidden file input.
// Conversion is async, so the file appears a beat after the drop/pick —
// acceptable for now.
//
// `window`, not `document`, is load-bearing: capture descends window → document
// → … → target, so stopImmediatePropagation() at *document* capture cannot stop
// a site whose own listener sits on window (the common "global app dropzone"
// pattern — copilot.microsoft.com does this). There, the site read the original
// file before we ever saw the event and attached it alongside our converted
// Markdown. window capture is the earliest slot in the path, and a
// document_start content script binds it before any page script runs, so we are
// unconditionally first.
//
// Window capture still can't see an input that was never appended to the DOM —
// a detached element's change has no propagation path at all. Sites that pick
// through one (kimi.com) get path 4: main-world.js hooks createElement, blocks
// the page's own change handlers at the element, and relays the files here
// over the postMessage bridge (bridge.js); the same pipeline runs, and the
// result rides the bridge back to be substituted into the site's own input.
//
// Ambiguous documents (substantial text plus charts) aren't injected silently:
// the user is prompted to convert to Markdown or send the original, and the
// chosen file is injected once they pick (see resolveAndInject / ui.js).
// Injection is all-or-nothing: a batch is injected in ONE .files assignment,
// after any prompt resolves. Injecting clear files early and ambiguous ones
// later would overwrite the first FileList, which only works if the site
// copies files synchronously in its change handler — not an assumption worth
// depending on.
//
// A passthrough hotkey (see passthrough.js) can arm a one-shot bypass: when
// armed, the handlers get out of the way and let the native upload proceed, so
// the original file is sent with no conversion.

import { restrictedSandbox } from "./rs-shim.js"; // must precede the pdf.js import chain
import { convertFile, convertViaCompanion } from "../convert/index.js";
import { companionAvailable, dedupeFileNames } from "../convert/result.js";
import { routeFile } from "../router/route.js";
import {
  extractFigures,
  figuresSupported,
  combineFiguresToSheet,
  separateFilesNote,
  MAX_FIGURES,
} from "../convert/figures.js";
import {
  extractPdfFigures,
  extractPdfFigureCrops,
  extractPdfFigureBoxes,
  extractPdfRasterFigures,
  pdfFiguresAvailable,
} from "../convert/pdf-figures.js";
import { buildChartPagesPdf, chartPagesNote } from "../convert/pdf-subset.js";
import { aggregateSavings } from "../convert/savings.js";
import {
  promptConvertChoice,
  showAttachFailureNotice,
  showConvertingBadge,
  showSavingsBadge,
  showUnconvertedNotice,
} from "./ui.js";
import { installPassthroughHotkey, consumePassthrough } from "./passthrough.js";
import { creditOnSubmit } from "./submit-credit.js";
import { MSG, bridgeMsg, isBridgeMsg, bridgeFiles } from "./bridge.js";
import { loadConfig, saveConfig, onConfigChanged } from "../config/config.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { browser } from "../browser.js";
import {
  CAPTURE_PING_MSG,
  CAPTURE_DELIVER_MSG,
  deliveredFiles,
} from "../capture/delivery.js";
import { recordLastTarget } from "../capture/last-target.js";

const TAG = "[decant]";
const SENTINEL = "__decantSynthetic";

// Live config bits — start at the defaults (routing converts PDFs, matching
// pre-routing behavior), then follow the stored config and any later
// options-page edits.
let routing = DEFAULT_CONFIG.routing;
let showSavings = DEFAULT_CONFIG.showSavings;
let ambiguousDefault = DEFAULT_CONFIG.ambiguousDefault;
const applyConfig = (c) => {
  routing = c.routing;
  showSavings = c.showSavings;
  ambiguousDefault = c.ambiguousDefault;
};
// Awaited before routing any intercepted file, so an upload in the first
// moments of a page load waits the few ms for the stored config instead of
// racing ahead with the defaults. A failed load keeps the defaults (as before).
const configReady = loadConfig().then(applyConfig).catch(() => {});
onConfigChanged(applyConfig);

// Append the figure-association footer to a converted Markdown File, so the
// model can connect the text's "[N images omitted — page 17]" markers to the
// attached figures. A fresh File (same name/type) keeps the original result
// object untouched.
async function withFiguresNote(convertedFile, note) {
  const text = await convertedFile.text();
  return new File(
    [`${text.trimEnd()}\n\n---\n\n${note}\n`],
    convertedFile.name,
    { type: convertedFile.type }
  );
}

function dataTransferWith(files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt;
}

// Bound an async step so a hang can't strand the upload. Firefox's sandbox can
// make pdf.js operations never settle (see rs-shim.js); racing a timeout turns
// that into a normal rejection the figures try/catch degrades from. The stranded
// work keeps running detached but is harmless — its result is just ignored.
const FIGURE_STEP_TIMEOUT_MS = 20000;
function withTimeout(promise, label, ms = FIGURE_STEP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Per-site intercept adapters — the first cut of the M2 adapter tier, moving
// to per-site config with profiles (M4).
//
// claude.ai and ChatGPT both substitute the converted file through a
// persistent hidden <input type=file> (assign .files + dispatch change); they
// differ only in how the drag overlay is dismissed after we block the real
// drop:
//   - overlayCleanup "placeholder-drop": re-dispatch a synthetic drop carrying
//     a 1-byte placeholder. claude.ai resets its overlay inside its own drop
//     handler and ignores the file (isTrusted false). ChatGPT would ACCEPT
//     that placeholder as a real upload (the decant-placeholder.txt leak), so
//     it must NOT use this.
//   - overlayCleanup "drag-exit" (default): synthetic dragleave + dragend.
//     Can never attach a stray file, so it's the safe default and the right
//     choice for ChatGPT (QA-confirmed it clears the overlay).
//
// Gemini can't substitute at all: its uploader rejects synthetic drops and its
// picker <input> is transient (Angular unbinds the change listener on
// destroy), so intercepting would only lose the upload — interceptDrop/Paste
// false steps aside and the native upload proceeds (picker path still
// converts). See the gemini-adapter memory for the full investigation.
// maxImageAttachments: the site's per-message image limit — more extracted
// figures than this combine into one labeled contact sheet instead of being
// dropped (see figures.js). claude.ai's limit is 5 (verify at QA); sites
// without a known limit take the extraction cap as-is.
const SITE_ADAPTERS = {
  "claude.ai": { overlayCleanup: "placeholder-drop", maxImageAttachments: 5 },
  "chatgpt.com": { overlayCleanup: "drag-exit" },
  "gemini.google.com": { interceptDrop: false, interceptPaste: false },
};
const adapter = SITE_ADAPTERS[location.hostname] ?? { overlayCleanup: "drag-exit" };

// Pick the file input to inject into. claude.ai currently mounts one, but if
// a second ever appears (avatar upload, project-knowledge modal), plain "last
// in DOM order" could hit the wrong one. Cheap preference ordering:
//   1. inputs whose accept is empty or mentions pdf / application/ types —
//      composer inputs are typically unrestricted, avatar inputs are image/*;
//   2. among those, an input near the composer (an ancestor within a few
//      levels also contains a contenteditable or textarea);
//   3. otherwise the last connected enabled input (original behavior).
// Heuristic and claude.ai-calibrated; belongs in per-surface config once the
// SURFACES.md tier lands.
function findUsableFileInput() {
  const usable = [
    ...document.querySelectorAll('input[type="file"]'),
  ].filter((el) => !el.disabled && el.isConnected);
  if (usable.length <= 1) return usable[0] || null;

  const acceptsDocuments = (el) => {
    const accept = (el.getAttribute("accept") || "").toLowerCase();
    return (
      accept === "" || accept.includes("pdf") || accept.includes("application/")
    );
  };
  const nearComposer = (el) => {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.querySelector('[contenteditable="true"], textarea')) return true;
    }
    return false;
  };

  const pool = usable.filter(acceptsDocuments);
  const tier = pool.length ? pool : usable;
  const near = tier.filter(nearComposer);
  const best = near.length ? near : tier;
  return best[best.length - 1];
}

// Convert each file, then hand the results to `inject` — (files) => boolean —
// in a single call. The change/drop/paste paths inject through the site's
// hidden input (injectViaInput); the detached-picker path posts the files back
// over the bridge instead. Either way it's all-or-nothing: ambiguous results
// (text plus charts) prompt the user to choose convert vs. original first —
// deciding before injecting avoids having to un-attach a chip. When a batch
// mixes clear and ambiguous files, the clear ones wait for the prompt too: a
// second injection would *replace* the input's FileList, which only works if
// the site copies files synchronously inside its change handler — an
// assumption we don't want to be load-bearing. The cost is a beat of extra
// latency on the clear files in the mixed-batch case only.
async function resolveAndInject(inject, fileArray) {
  // Route with the user's stored config, not the defaults it may still be
  // racing against right after page load.
  await configReady;
  const immediate = [];
  const ambiguous = [];
  // Results actually sent as Markdown — the basis for the token-savings badge.
  const converted = [];
  // Progress badge per file: conversion can take a while on large PDFs, and
  // without it a slow conversion looks like a swallowed drop.
  let badge = null;
  try {
    for (const f of fileArray) {
      badge?.remove();
      badge = showConvertingBadge(f.name);
      const r = await convertFile(f, routing);
      logResult(f, r);
      if (r.action === "ambiguous") ambiguous.push(r);
      else {
        immediate.push(r.file);
        if (r.action === "converted") converted.push(r);
      }
    }
  } finally {
    badge?.remove();
  }

  let chosen = [];
  if (ambiguous.length) {
    // Offer the richer choices only when every ambiguous file supports them
    // (so the single-file case — the norm — just checks that file's rule/type):
    // companion when an endpoint is configured, figures when the document's
    // images are recoverable — extractable zip entries (PPTX/DOCX) or
    // renderable chart pages (PDF).
    const companion = ambiguous.every((r) => companionAvailable(r.rule));
    const figures = ambiguous.every(
      (r) =>
        (figuresSupported(r.file) && (r.meta?.images ?? 0) > 0) ||
        pdfFiguresAvailable(r.meta)
    );
    // A remembered default (set from the prompt's checkbox or the options
    // page) skips the prompt — but only when it's available for this batch;
    // a companion/figures default that can't apply falls back to asking
    // rather than silently picking something else.
    const available = { convert: true, original: true, companion, figures };
    let choice = "original";
    if (ambiguousDefault !== "ask" && available[ambiguousDefault]) {
      choice = ambiguousDefault;
      console.log(TAG, `ambiguous default applied: ${choice} (change in options)`);
    } else {
      try {
        const res = await promptConvertChoice(ambiguous, { companion, figures });
        choice = res.choice;
        if (res.remember) {
          // Fire-and-forget: the default applies from the next upload on
          // either way (onConfigChanged also updates this tab).
          loadConfig()
            .then((c) => saveConfig({ ...c, ambiguousDefault: res.choice }))
            .catch((err) => console.warn(TAG, "couldn't save ambiguous default:", err));
        }
      } catch (err) {
        console.warn(TAG, "prompt failed, sending originals:", err);
      }
    }
    console.log(TAG, `ambiguous → ${choice}:`, ambiguous.map((r) => r.file.name));

    if (choice === "companion") {
      // Send each original to its companion endpoint (Docling etc.), which can
      // keep the visuals the text-only path drops. A failed/unreachable
      // conversion falls back to the original — never lose the file.
      let badge = null;
      try {
        for (const r of ambiguous) {
          badge?.remove();
          badge = showConvertingBadge(r.file.name);
          try {
            chosen.push(await convertViaCompanion(r.file, r.rule));
            // A companion conversion is sent as Markdown too — count it toward
            // the savings badge exactly like the text-only choice does.
            converted.push(r);
          } catch (err) {
            console.warn(TAG, `companion conversion failed for ${r.file.name} — sending original:`, err);
            chosen.push(r.file);
          }
        }
      } finally {
        badge?.remove();
      }
    } else if (choice === "figures") {
      // Extract-and-reference (SPEC M3): attach the converted Markdown plus
      // the document's own figures as sibling files. Extraction failing or
      // finding nothing (all media junk-filtered) degrades to the text-only
      // conversion — the upload itself is never blocked on it.
      const maxImages = adapter.maxImageAttachments ?? MAX_FIGURES;
      // Progress badge, as on the companion path: rendering chart pages and
      // building the mini-PDF takes seconds on a figure-heavy document, and
      // the prompt has already closed — without it the wait after clicking
      // “Convert + attach figures” looks like a swallowed upload.
      let figBadge = null;
      try {
        for (const r of ambiguous) {
          figBadge?.remove();
          figBadge = showConvertingBadge(r.file.name, "extracting figures from");
          // Figures are computed first so the Markdown can gain an association
          // footer naming them; the (possibly annotated) .md still attaches
          // ahead of its figures.
          const attachments = [];
          let note = null;
          let mdFile = r.converted; // safe default: attach text-only on any failure
          // Pages whose image layer we reattach (mini-PDF pages / page renders)
          // were NOT saved — the savings estimate nets them out.
          let attachedFigurePages = 0;
          try {
            if (figuresSupported(r.file)) {
              // Zip formats (PPTX/DOCX): pull the media entries. Over the
              // site's per-message image limit they combine into one labeled
              // contact sheet; if compositing fails, attach what fits.
              const figs = await extractFigures(r.file);
              if (figs.length > maxImages) {
                try {
                  const sheet = await combineFiguresToSheet(figs, r.file.name);
                  attachments.push(sheet);
                  note = `The document's ${figs.length} images are attached combined as "${sheet.name}" — a labeled grid; each tile is captioned with its figure name.`;
                  console.log(TAG, `attached ${figs.length} figures as one sheet for ${r.file.name}`);
                } catch (err) {
                  console.warn(TAG, `figure sheet failed for ${r.file.name} — attaching first ${maxImages}:`, err);
                  attachments.push(...figs.slice(0, maxImages));
                }
              } else if (figs.length) {
                attachments.push(...figs);
                console.log(TAG, `attaching ${figs.length} figure(s) for ${r.file.name}`);
              }
              if (!note && attachments.length) {
                note = separateFilesNote(attachments);
              }
            } else {
              // PDF: one chart-pages-only mini-PDF. A document attachment
              // doesn't count against the image limit, and the platform renders
              // its pages natively. Each chart page is tightened to its figure
              // region so the model pays for the figure, not the whole page; a
              // page with no detectable figure copies whole.
              //
              // Two crop strategies by engine: Chrome rasterizes the figure region
              // to a PNG (extractPdfFigureCrops); Firefox can't run pdf.js canvas
              // rendering in the content-script sandbox — it hangs (see rs-shim.js)
              // — so it crops the vector page to the figure box via setCropBox
              // (extractPdfFigureBoxes), geometry only, no rendering. Either way a
              // failure just degrades to whole pages / text-only.
              // Highest-fidelity tier first: pages whose figure IS a single
              // embedded raster (photo/diagram) get the XObject's own pixels
              // decoded (render-free — getOperatorList only, so it's tried on
              // both engines). Pages the gate declines stay on the crop path.
              let rasters = null;
              try {
                rasters = await withTimeout(extractPdfRasterFigures(r.file, r.meta), "raster figures");
                if (rasters?.size) console.log(TAG, `decoded ${rasters.size} raster figure(s) for ${r.file.name}`);
              } catch (err) {
                console.warn(TAG, `raster figure decode failed for ${r.file.name} — using crops:`, err);
              }
              const rasterPages = rasters?.size ? new Set(rasters.keys()) : null;
              let crops = null;
              let boxes = null;
              if (restrictedSandbox) {
                try {
                  boxes = await withTimeout(extractPdfFigureBoxes(r.file, r.meta, rasterPages), "figure boxes");
                } catch (err) {
                  console.warn(TAG, `figure boxes failed for ${r.file.name} — using whole pages:`, err);
                }
              } else {
                try {
                  crops = await withTimeout(extractPdfFigureCrops(r.file, r.meta, rasterPages), "figure crops");
                } catch (err) {
                  console.warn(TAG, `figure crops failed for ${r.file.name} — using whole pages:`, err);
                }
              }
              // Decoded rasters ride the crops slot of the mini-PDF builder
              // (same shape; jpg instead of png).
              if (rasters?.size) crops = new Map([...(crops ?? []), ...rasters]);
              // Human/model-facing page references use the document's printed
              // labels when the PDF defines them (matching the "[images
              // omitted — page N]" markers and the in-page stamps).
              const labelOf = (n) => r.meta?.pageLabels?.[n - 1] ?? n;
              try {
                const subset = await withTimeout(buildChartPagesPdf(r.file, r.meta, crops, boxes), "chart-pages PDF");
                if (subset) {
                  attachments.push(subset.file);
                  attachedFigurePages = subset.pages.length;
                  note = chartPagesNote(subset, r.meta);
                  console.log(TAG, `attaching chart-pages PDF (${subset.pages.length} pages, ${(crops?.size ?? 0) + (boxes?.size ?? 0)} cropped) for ${r.file.name}`);
                }
              } catch (err) {
                console.warn(TAG, `chart-pages PDF failed for ${r.file.name}:`, err);
                if (restrictedSandbox) throw err; // no pdf.js render fallback here — degrade to text-only
                const figs = (await withTimeout(extractPdfFigures(r.file, r.meta), "figure render")).slice(0, maxImages);
                attachments.push(...figs);
                attachedFigurePages = figs.length;
                if (figs.length) {
                  note = `The document's figure pages are attached as images: ${figs
                    .map((f) => {
                      const n = Number(f.name.match(/-p(\d+)\.png$/)?.[1]);
                      return `"${f.name}" = document page ${labelOf(n)}`;
                    })
                    .join(", ")}.`;
                }
              }
            }
            if (note) mdFile = await withFiguresNote(r.converted, note);
          } catch (err) {
            // Any failure in the figures path degrades to the plain converted
            // Markdown — the upload is never lost to figure extraction. (Note the
            // withFiguresNote call is INSIDE this try: it reads the converted file
            // and must not be able to escape the guard.)
            console.warn(TAG, `figure extraction failed for ${r.file.name} — sending text only:`, err);
            mdFile = r.converted;
            attachments.length = 0;
            attachedFigurePages = 0;
          }
          chosen.push(mdFile);
          chosen.push(...attachments);
          // Count toward the savings badge with the reattached pages netted out.
          converted.push(
            attachedFigurePages ? { ...r, attachedFigurePages } : r
          );
        }
      } finally {
        figBadge?.remove();
      }
    } else {
      chosen = ambiguous.map((r) => (choice === "convert" ? r.converted : r.file));
      if (choice === "convert") converted.push(...ambiguous);
    }
  }

  // Distinct names before injection: converting to ".md" can collide two
  // same-stem uploads (a.pdf + a.docx → a.md), which some uploaders dedupe by
  // dropping one.
  const files = dedupeFileNames([...immediate, ...chosen]);
  const injected = files.length ? inject(files) : false;
  // This host is now "the chat you last used" for capture's cold-start
  // fallback (SPEC §3.11) — same success signal the savings credit keys off.
  if (injected) recordLastTarget(location.hostname);

  // Estimated token savings (the eliminated PDF page-image layer) — a brief
  // positive badge after a successful conversion.
  const savings = aggregateSavings(converted);
  if (savings) {
    console.log(TAG, `est. savings: ~${savings.savedTokens} tokens (~${savings.percent}%)`);
    if (showSavings) showSavingsBadge(savings);
    // Lifetime counter: armed only for a batch that actually made it into the
    // upload, and credited only when the message is sent (see submit-credit.js)
    // — a converted file abandoned in the composer never counts.
    if (injected) creditOnSubmit(savings.savedTokens);
  }
}

function logResult(f, r) {
  // PDF summaries carry page stats; DOCX summaries carry an image count.
  const pages =
    r.meta?.pageCount != null
      ? ` [${r.meta.contentPages}/${r.meta.pageCount} text pages, ${r.meta.chartPages} chart pages]`
      : r.meta?.images != null
        ? ` [${r.meta.images} images]`
        : "";
  if (r.action === "converted") {
    // meta is the PDF classifier's summary; http/companion results don't
    // carry one.
    const stats = r.meta ? ` (${r.meta.pageCount}p, ${r.meta.totalChars} chars)` : "";
    console.log(TAG, `converted ${f.name} → ${r.file.name}${stats} [${r.reason}]`);
  } else if (r.action === "ambiguous") {
    console.log(TAG, `ambiguous ${f.name}${pages} — prompting`);
  } else {
    console.log(TAG, `passthrough ${f.name} (${r.reason})${pages}`);
  }
}

// Inject the (possibly converted) files into the upload by swapping the hidden
// input's .files and dispatching a trusted-looking change event.
//
// The input is resolved (or re-resolved) here, at injection time, not when the
// attach was intercepted: conversion is async, and if the site re-renders in
// between, an input captured earlier can be disconnected by now — .files
// assignment on it still "works" but the change event never reaches the app,
// silently losing the upload. `preferred` is the input that fired the original
// change event (the right one when still connected); drop/paste pass null.
// If no usable input exists at all, surface a visible notice — a swallowed
// attach with no feedback is the worst failure mode this extension can have.
// Returns whether the files reached an input (the savings credit keys off it).
function injectViaInput(preferred, files) {
  const input =
    preferred && preferred.isConnected ? preferred : findUsableFileInput();
  if (!input) {
    console.warn(
      TAG,
      "no usable <input type=file> at injection time — attach lost:",
      files.map((f) => f.name)
    );
    showAttachFailureNotice(files.map((f) => f.name));
    return false;
  }
  input.files = dataTransferWith(files).files;
  const change = new Event("change", { bubbles: true });
  change[SENTINEL] = true;
  input.dispatchEvent(change);
  return true;
}

// Serialize batches across separate upload events. Within a batch injection is
// already all-or-nothing, but two *concurrent* resolveAndInject calls (a slow
// PDF still converting when a second file is dropped) would each assign the
// hidden input's .files, and the second overwrites the first — losing a batch on
// any site that copies input.files asynchronously. Chaining keeps them
// sequential; a batch's own failure is caught so it never stalls the chain. A
// single multi-file drop is one batch, so ordinary multi-file uploads are
// unaffected — only genuinely separate events queue.
//
// `onFail` (optional) runs after a batch fails, alongside the failure notice —
// the bridge path uses it to RELEASE the pending pick so the site's native
// handler still fires with the originals instead of the upload vanishing.
let injectChain = Promise.resolve();
function queueInject(inject, files, label, onFail) {
  const run = injectChain.then(() =>
    resolveAndInject(inject, files).catch((err) => {
      console.warn(TAG, `resolveAndInject failed (${label}):`, err);
      showAttachFailureNotice(files.map((f) => f.name));
      onFail?.();
    })
  );
  injectChain = run.catch(() => {}); // keep the chain alive regardless of outcome
  return run;
}

// ---------------------------------------------------------------- change ---
window.addEventListener(
  "change",
  (ev) => {
    if (!ev.isTrusted) return; // ignore page-synthesized events
    const target = ev.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "file") return;
    if (ev[SENTINEL]) return;
    if (!target.files || target.files.length === 0) return;

    // Passthrough hotkey armed → let the native upload proceed untouched.
    if (consumePassthrough()) {
      console.log(TAG, "passthrough hotkey → sending original (picker)");
      return;
    }

    // Capture File references now — the FileList may be cleared after the event.
    const originals = Array.from(target.files);
    console.log(TAG, "change intercepted:", originals.map((f) => f.name));
    ev.stopImmediatePropagation();

    // Serialized + never silent: the native event is already blocked, so any
    // unexpected throw must surface as an attach-failure notice, and concurrent
    // batches must not clobber each other's FileList (see queueInject).
    queueInject((files) => injectViaInput(target, files), originals, "change");
  },
  true
);

// Dismiss the site's drag overlay after we've blocked the real drop, using the
// adapter's strategy (see SITE_ADAPTERS). Fires synchronously so the overlay
// releases immediately rather than waiting on the async conversion.
function clearDropOverlay(ev) {
  if (adapter.overlayCleanup === "placeholder-drop") {
    // A synthetic drop with a 1-byte placeholder makes the site's drop handler
    // run and reset its overlay; claude.ai ignores the file (isTrusted false).
    // An empty dataTransfer makes claude's handler bail before resetting, so
    // the placeholder must be present.
    const placeholder = new File(["x"], "decant-placeholder.txt", { type: "text/plain" });
    const cleanupDrop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransferWith([placeholder]),
      clientX: ev.clientX,
      clientY: ev.clientY,
    });
    cleanupDrop[SENTINEL] = true;
    ev.target.dispatchEvent(cleanupDrop);
  } else {
    // "drag-exit": dragleave + dragend never attach a file, so they're safe
    // on sites (ChatGPT) that would accept the placeholder drop as an upload.
    for (const type of ["dragleave", "dragend"]) {
      const e = new DragEvent(type, { bubbles: true });
      e[SENTINEL] = true;
      ev.target.dispatchEvent(e);
    }
  }
}

// ------------------------------------------------------------------ drop ---
// Two steps are needed:
//   (a) populate the hidden <input type="file"> and dispatch change — the
//       reliable way to add a file; a synthetic DragEvent isn't trusted as a
//       file source. This carries the converted file and happens after the
//       async conversion resolves.
//   (b) immediately clear the site's "drag active" overlay via the adapter's
//       overlayCleanup strategy (clearDropOverlay), synchronously, so the
//       overlay releases instantly rather than waiting on conversion.
window.addEventListener(
  "drop",
  (ev) => {
    if (!ev.isTrusted) return; // ignore page-synthesized events
    if (ev[SENTINEL]) return;
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Capture File references now — the DataTransfer is cleared after drop.
    const originals = Array.from(files);
    // When standing aside sends the original natively, a brief notice keeps it
    // from looking like Decant didn't run — but only when conversion was
    // actually forgone; a file routing to passthrough anyway changes nothing.
    const noticeIfConvertible = () => {
      if (originals.some((f) => routeFile(f, routing).action !== "passthrough")) {
        showUnconvertedNotice("drag-and-drop");
      }
    };

    // Site adapter says drops can't be substituted here → let the native
    // drop proceed with the original file (see SITE_ADAPTERS). An armed
    // passthrough state is consumed: native upload is the passthrough.
    if (adapter.interceptDrop === false) {
      consumePassthrough();
      console.log(TAG, "drop: site adapter → native drop, original sent unconverted");
      noticeIfConvertible();
      return;
    }

    // No substitution channel, no interception (ADR 0020): drop/paste inject
    // through a connected <input type=file>, and on a detached-picker site
    // (kimi.com) none ever exists — blocking the drop would only convert into
    // a dead end and lose the upload. Checked at drop time; a site that
    // mounts its input only after some later interaction would be misjudged
    // here, but every known full-treatment site keeps one mounted.
    if (!findUsableFileInput()) {
      consumePassthrough();
      console.log(TAG, "drop: no usable file input to inject through → native drop, original sent unconverted");
      noticeIfConvertible();
      return;
    }

    // Passthrough hotkey armed → don't intercept; let the native drop proceed
    // so Claude receives the original file unchanged.
    if (consumePassthrough()) {
      console.log(TAG, "passthrough hotkey → sending original (drop)");
      return;
    }

    console.log(TAG, "drop intercepted:", originals.map((f) => f.name));
    ev.preventDefault();
    ev.stopImmediatePropagation();

    // (b) Clear the dropzone overlay right away (per-site strategy).
    clearDropOverlay(ev);

    // (a) Convert, then inject through the hidden input. The input is resolved
    // at injection time (see injectViaInput), after the async conversion.
    queueInject((files) => injectViaInput(null, files), originals, "drop");
  },
  true
);

// ----------------------------------------------------------------- paste ---
// ClipboardEvent.clipboardData is read-only and can't be reconstructed via the
// constructor, so we can't re-dispatch a synthetic paste. We don't need to:
// block the original paste and route the converted file through the hidden
// file input, exactly like the drop path. No overlay to release here, so paste
// is the simplest of the three. Text-only pastes are left untouched.
window.addEventListener(
  "paste",
  (ev) => {
    if (!ev.isTrusted) return; // ignore page-synthesized events
    if (ev[SENTINEL]) return;
    const cd = ev.clipboardData;
    if (!cd) return;

    // Capture File references synchronously — clipboardData is only valid for
    // the duration of the event. Prefer .files; fall back to item.getAsFile().
    let originals = Array.from(cd.files || []);
    if (originals.length === 0 && cd.items) {
      originals = Array.from(cd.items)
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter(Boolean);
    }
    if (originals.length === 0) return; // text-only paste — leave it alone

    // Office cell copies (Excel/Word) put text/plain + text/html on the
    // clipboard AND an image/png rendition in .files. If the clipboard carries
    // text and none of its files would actually convert, the user meant to paste
    // the text — hijacking it to attach the image rendition drops what they
    // wanted. Only intercept when a file would route to conversion, or when
    // there's no text alternative (a pure image/file paste, e.g. a screenshot).
    const hasText = Array.from(cd.types || []).includes("text/plain");
    const willConvert = originals.some(
      (f) => routeFile(f, routing).action !== "passthrough"
    );
    if (hasText && !willConvert) {
      console.log(TAG, "paste has text and no convertible file → leaving native paste");
      return;
    }

    // As on the drop path: standing aside warrants a brief notice, but only
    // when conversion was actually forgone.
    const noticeIfConvertible = () => {
      if (willConvert) showUnconvertedNotice("paste");
    };

    // Site adapter: same reasoning as the drop path.
    if (adapter.interceptPaste === false) {
      consumePassthrough();
      console.log(TAG, "paste: site adapter → native paste, original sent unconverted");
      noticeIfConvertible();
      return;
    }

    // No connected file input to inject through → stand aside (ADR 0020),
    // same reasoning as the drop path.
    if (!findUsableFileInput()) {
      consumePassthrough();
      console.log(TAG, "paste: no usable file input to inject through → native paste, original sent unconverted");
      noticeIfConvertible();
      return;
    }

    // Passthrough hotkey armed → let the native paste proceed untouched.
    if (consumePassthrough()) {
      console.log(TAG, "passthrough hotkey → sending original (paste)");
      return;
    }

    console.log(TAG, "paste intercepted:", originals.map((f) => f.name));
    ev.preventDefault();
    ev.stopImmediatePropagation();

    // Input resolved at injection time (see injectViaInput).
    queueInject((files) => injectViaInput(null, files), originals, "paste");
  },
  true
);

// ------------------------------------------------------- detached picker ---
// Picks relayed by the MAIN-world shim (main-world.js): a site that picks
// through a createElement'd input never appended to the DOM fires change on
// the element only, invisible to the window listeners above. The shim blocked
// the page's handlers at the element and holds the input; this side runs the
// normal pipeline and posts the result back — INJECT substitutes the files
// into that same input before its change is re-dispatched, RELEASE re-fires
// it with the originals (passthrough, or a failed batch degrading to the
// native path so the upload is never lost). The page can forge PICK messages,
// but only with files it already holds — conversion hands its own data back
// (see bridge.js); shape is still validated hard.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  if (!isBridgeMsg(ev.data, MSG.PICK)) return;
  const { id } = ev.data;
  const originals = bridgeFiles(ev.data);
  if (!Number.isFinite(id) || originals.length === 0) return;
  const release = () => window.postMessage(bridgeMsg(MSG.RELEASE, { id }), location.origin);

  // Passthrough hotkey armed → RELEASE re-fires the pick with the originals,
  // the detached-path equivalent of standing aside for the native upload.
  if (consumePassthrough()) {
    console.log(TAG, "passthrough hotkey → sending original (detached picker)");
    release();
    return;
  }

  console.log(TAG, "detached-picker intercepted:", originals.map((f) => f.name));
  queueInject(
    (files) => {
      window.postMessage(bridgeMsg(MSG.INJECT, { id, files }), location.origin);
      return true;
    },
    originals,
    "detached picker",
    release
  );
});
// Arm the shim: until this lands it lets picks flow natively, so a page whose
// isolated script somehow failed degrades to no conversion, not lost uploads.
window.postMessage(bridgeMsg(MSG.READY), location.origin);

// -------------------------------------------------------- capture inbox ---
// The receiving end of page capture (SPEC §3.11): the background delivers an
// already-converted page.md (plus figures later) for injection into this
// chat's composer. PING is the cold-tab handshake — the background retries it
// until this listener exists, so its answer must be synchronous and
// unconditional.
//
// Injection waits for a usable file input up to the background's deadline
// (cold SPA composers mount seconds after the content script runs), and rides
// the same injectChain as intercepted batches so a capture can't clobber a
// concurrent upload's FileList. No conversion happens here — the payload
// arrived converted.
function waitForUsableInput(waitMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 30000);
  return new Promise((resolve) => {
    const tick = () => {
      const input = findUsableFileInput();
      if (input) return resolve(input);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

// Cold tabs: an input EXISTING is not the app LISTENING. Copilot ships its
// hidden file input in the pre-hydration HTML but binds its upload handler
// (window-level, capture) only once the app boots — injecting the moment the
// input appears dispatches change into a deaf page and silently loses the
// files (live-QA'd: warm copilot delivered, cold "delivered" nothing). No
// generic ready signal exists, so cold deliveries settle: wait out the load
// event (bounded — an SPA that never fires it shouldn't stall the capture),
// then give hydration a grace period before injecting.
const COLD_HYDRATION_SETTLE_MS = 3000;
const COLD_LOAD_CAP_MS = 15000;
function coldSettle() {
  const loaded =
    document.readyState === "complete"
      ? Promise.resolve()
      : new Promise((r) => {
          window.addEventListener("load", r, { once: true });
          setTimeout(r, COLD_LOAD_CAP_MS);
        });
  return loaded.then(() => new Promise((r) => setTimeout(r, COLD_HYDRATION_SETTLE_MS)));
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === CAPTURE_PING_MSG) {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type !== CAPTURE_DELIVER_MSG) return;
  (async () => {
    const files = deliveredFiles(msg); // validates hard; throws → catch below
    console.log(TAG, "capture delivery:", files.map((f) => f.name));
    const run = injectChain.then(async () => {
      const input = await waitForUsableInput(msg.waitMs);
      if (!input) return false;
      if (msg.cold === true) await coldSettle();
      // injectViaInput re-resolves if the settle outlived this input node.
      return injectViaInput(input, files);
    });
    injectChain = run.catch(() => {});
    const injected = await run;
    if (injected) recordLastTarget(location.hostname);
    sendResponse(injected ? { ok: true } : { ok: false, reason: "no-input" });
  })().catch((err) => {
    console.warn(TAG, "capture delivery failed:", err);
    sendResponse({ ok: false, reason: String(err?.message || err) });
  });
  return true; // sendResponse is async
});

installPassthroughHotkey();
console.log(TAG, "intercept installed at", location.href);
