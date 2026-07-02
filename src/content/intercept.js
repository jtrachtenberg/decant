// Decant — content script: intercept → convert → substitute.
//
// Listens for file-attach events on claude.ai, runs each file through the
// converter (PDF → Markdown, everything else passthrough), and substitutes
// the result into the upload before Claude sees it.
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

import { convertFile } from "../convert/index.js";
import {
  promptConvertChoice,
  showAttachFailureNotice,
  showConvertingBadge,
} from "./ui.js";
import { installPassthroughHotkey, consumePassthrough } from "./passthrough.js";

const TAG = "[decant]";
const SENTINEL = "__decantSynthetic";

function dataTransferWith(files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt;
}

function findUsableFileInput() {
  const inputs = document.querySelectorAll('input[type="file"]');
  let best = null;
  for (const el of inputs) {
    if (el.disabled || !el.isConnected) continue;
    best = el;
  }
  return best;
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
  const immediate = [];
  const ambiguous = [];
  // Progress badge per file: conversion can take a while on large PDFs, and
  // without it a slow conversion looks like a swallowed drop.
  let badge = null;
  try {
    for (const f of fileArray) {
      badge?.remove();
      badge = showConvertingBadge(f.name);
      const r = await convertFile(f);
      logResult(f, r);
      if (r.action === "ambiguous") ambiguous.push(r);
      else immediate.push(r.file);
    }
  } finally {
    badge?.remove();
  }

  let chosen = [];
  if (ambiguous.length) {
    let choice = "original";
    try {
      choice = await promptConvertChoice(ambiguous);
    } catch (err) {
      console.warn(TAG, "prompt failed, sending originals:", err);
    }
    console.log(TAG, `ambiguous → ${choice}:`, ambiguous.map((r) => r.file.name));
    chosen = ambiguous.map((r) => (choice === "convert" ? r.converted : r.file));
  }

  const files = [...immediate, ...chosen];
  if (files.length) injectViaInput(preferredInput, files);
}

function logResult(f, r) {
  const pages = r.meta
    ? ` [${r.meta.contentPages}/${r.meta.pageCount} text pages, ${r.meta.chartPages} chart pages]`
    : "";
  if (r.action === "converted") {
    console.log(
      TAG,
      `converted ${f.name} → ${r.file.name}`,
      `(${r.meta.pageCount}p, ${r.meta.totalChars} chars)`
    );
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
  const change = new Event("change", { bubbles: true, cancelable: true });
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

// ------------------------------------------------------------------ drop ---
// Two synthesized events are needed on Claude:
//   (a) populate the hidden <input type="file"> and dispatch change — the
//       reliable way to add a file; a synthetic DragEvent isn't trusted as a
//       file source. This carries the converted file and happens after the
//       async conversion resolves.
//   (b) immediately dispatch a synthetic drop on the original target so
//       Claude's drop handler runs and clears its "drag active" overlay. An
//       empty dataTransfer makes the handler bail before resetting state, so
//       the cleanup drop carries a 1-byte placeholder (ignored by Claude
//       because isTrusted === false). This fires synchronously so the overlay
//       releases instantly rather than waiting on conversion.
document.addEventListener(
  "drop",
  (ev) => {
    if (ev[SENTINEL]) return;
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || files.length === 0) return;

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

    // (b) Clear the dropzone overlay right away.
    const placeholder = new File(["x"], "decant-placeholder.txt", {
      type: "text/plain",
    });
    const cleanupDrop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransferWith([placeholder]),
      clientX: ev.clientX,
      clientY: ev.clientY,
    });
    cleanupDrop[SENTINEL] = true;
    ev.target.dispatchEvent(cleanupDrop);

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
