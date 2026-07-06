// Decant — content script: intercept → convert → substitute.
//
// Listens for file-attach events on claude.ai, runs each file through the
// converter — the routing table decides its fate (default: PDF → Markdown,
// everything else passthrough) — and substitutes the result into the upload
// before Claude sees it.
//
// Three attach paths:
//   1. <input type="file"> change   (file-picker / paperclip button)
//   2. drop                          (drag-and-drop onto the composer)
//   3. paste                         (file pasted from clipboard)
//
// Listeners run in the capture phase at document_start, ahead of Claude's own
// handlers. We block the original event synchronously, then convert
// asynchronously and re-inject through the hidden file input. Conversion is
// async, so the file appears a beat after the drop/pick — acceptable for now.
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

import { convertFile, convertViaCompanion } from "../convert/index.js";
import { companionAvailable } from "../convert/result.js";
import {
  extractFigures,
  figuresSupported,
  combineFiguresToSheet,
  MAX_FIGURES,
} from "../convert/figures.js";
import { extractPdfFigures, pdfFiguresAvailable } from "../convert/pdf-figures.js";
import { buildChartPagesPdf } from "../convert/pdf-subset.js";
import { aggregateSavings } from "../convert/savings.js";
import {
  promptConvertChoice,
  showAttachFailureNotice,
  showConvertingBadge,
  showSavingsBadge,
} from "./ui.js";
import { installPassthroughHotkey, consumePassthrough } from "./passthrough.js";
import { loadConfig, saveConfig, onConfigChanged } from "../config/config.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

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

function dataTransferWith(files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt;
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

// Convert each file, then inject the results into the upload in a single
// .files assignment. Ambiguous results (text plus charts) prompt the user to
// choose convert vs. original first — deciding before injecting avoids having
// to un-attach a chip. When a batch mixes clear and ambiguous files, the clear
// ones wait for the prompt too: a second injection would *replace* the input's
// FileList, which only works if the site copies files synchronously inside its
// change handler — an assumption we don't want to be load-bearing. The cost is
// a beat of extra latency on the clear files in the mixed-batch case only.
async function resolveAndInject(preferredInput, fileArray) {
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
      for (const r of ambiguous) {
        chosen.push(r.converted);
        try {
          if (figuresSupported(r.file)) {
            // Zip formats (PPTX/DOCX): pull the media entries. Over the
            // site's per-message image limit they combine into one labeled
            // contact sheet; if compositing fails, attach what fits.
            const figs = await extractFigures(r.file);
            if (figs.length > maxImages) {
              try {
                chosen.push(await combineFiguresToSheet(figs, r.file.name));
                console.log(TAG, `attached ${figs.length} figures as one sheet for ${r.file.name}`);
              } catch (err) {
                console.warn(TAG, `figure sheet failed for ${r.file.name} — attaching first ${maxImages}:`, err);
                chosen.push(...figs.slice(0, maxImages));
              }
            } else {
              console.log(TAG, `attaching ${figs.length} figure(s) for ${r.file.name}`);
              chosen.push(...figs);
            }
          } else {
            // PDF: one chart-pages-only mini-PDF. A document attachment
            // doesn't count against the image limit, and the platform
            // renders its pages natively — full fidelity, no tiles. Falls
            // back to page renders (sliced to the image limit) when pdf-lib
            // can't rebuild the document (e.g. encrypted).
            try {
              const subset = await buildChartPagesPdf(r.file, r.meta);
              if (subset) {
                console.log(TAG, `attaching chart-pages PDF (${r.meta.chartPageNumbers.length} pages) for ${r.file.name}`);
                chosen.push(subset);
              }
            } catch (err) {
              console.warn(TAG, `chart-pages PDF failed for ${r.file.name} — rendering pages:`, err);
              const figs = await extractPdfFigures(r.file, r.meta);
              chosen.push(...figs.slice(0, maxImages));
            }
          }
        } catch (err) {
          console.warn(TAG, `figure extraction failed for ${r.file.name} — sending text only:`, err);
        }
      }
      converted.push(...ambiguous);
    } else {
      chosen = ambiguous.map((r) => (choice === "convert" ? r.converted : r.file));
      if (choice === "convert") converted.push(...ambiguous);
    }
  }

  const files = [...immediate, ...chosen];
  if (files.length) injectViaInput(preferredInput, files);

  // Estimated token savings (the eliminated PDF page-image layer) — a brief
  // positive badge after a successful conversion.
  const savings = aggregateSavings(converted);
  if (savings) {
    console.log(TAG, `est. savings: ~${savings.savedTokens} tokens (~${savings.percent}%)`);
    if (showSavings) showSavingsBadge(savings);
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
    return;
  }
  input.files = dataTransferWith(files).files;
  const change = new Event("change", { bubbles: true });
  change[SENTINEL] = true;
  input.dispatchEvent(change);
}

// ---------------------------------------------------------------- change ---
document.addEventListener(
  "change",
  (ev) => {
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

    resolveAndInject(target, originals);
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
document.addEventListener(
  "drop",
  (ev) => {
    if (ev[SENTINEL]) return;
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Site adapter says drops can't be substituted here → let the native
    // drop proceed with the original file (see SITE_ADAPTERS). An armed
    // passthrough state is consumed: native upload is the passthrough.
    if (adapter.interceptDrop === false) {
      consumePassthrough();
      console.log(TAG, "drop: site adapter → native drop, original sent unconverted");
      return;
    }

    // Passthrough hotkey armed → don't intercept; let the native drop proceed
    // so Claude receives the original file unchanged.
    if (consumePassthrough()) {
      console.log(TAG, "passthrough hotkey → sending original (drop)");
      return;
    }

    // Capture File references now — the DataTransfer is cleared after drop.
    const originals = Array.from(files);
    console.log(TAG, "drop intercepted:", originals.map((f) => f.name));
    ev.preventDefault();
    ev.stopImmediatePropagation();

    // (b) Clear the dropzone overlay right away (per-site strategy).
    clearDropOverlay(ev);

    // (a) Convert, then inject through the hidden input. The input is resolved
    // at injection time (see injectViaInput), after the async conversion.
    resolveAndInject(null, originals);
  },
  true
);

// ----------------------------------------------------------------- paste ---
// ClipboardEvent.clipboardData is read-only and can't be reconstructed via the
// constructor, so we can't re-dispatch a synthetic paste. We don't need to:
// block the original paste and route the converted file through the hidden
// file input, exactly like the drop path. No overlay to release here, so paste
// is the simplest of the three. Text-only pastes are left untouched.
document.addEventListener(
  "paste",
  (ev) => {
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

    // Site adapter: same reasoning as the drop path.
    if (adapter.interceptPaste === false) {
      consumePassthrough();
      console.log(TAG, "paste: site adapter → native paste, original sent unconverted");
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
    resolveAndInject(null, originals);
  },
  true
);

installPassthroughHotkey();
console.log(TAG, "intercept installed at", location.href);
