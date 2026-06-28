// Decant — content script: intercept → convert → substitute.
//
// Listens for file-attach events on claude.ai, runs each file through the
// converter (PDF → Markdown, everything else passthrough), and substitutes
// the result into the upload before Claude sees it.
//
// Three attach paths:
//   1. <input type="file"> change   (file-picker / paperclip button)
//   2. drop                          (drag-and-drop onto the composer)
//   3. paste                         (file pasted from clipboard) — TODO
//
// Listeners run in the capture phase at document_start, ahead of Claude's own
// handlers. We block the original event synchronously, then convert
// asynchronously and re-inject through the hidden file input. Conversion is
// async, so the file appears a beat after the drop/pick — acceptable for now.

import { convertFile } from "../convert/index.js";

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

// Run every file through the converter, logging what happened to each.
// Returns the list of files to actually hand to the upload target.
async function processFiles(fileArray) {
  const out = [];
  for (const f of fileArray) {
    const r = await convertFile(f);
    if (r.action === "converted") {
      console.log(
        TAG,
        `converted ${f.name} → ${r.file.name}`,
        `(${r.meta.pageCount}p, ~${Math.round(r.meta.avgChars)} chars/pg)`
      );
    } else {
      console.log(TAG, `passthrough ${f.name} (${r.reason})`);
    }
    out.push(r.file);
  }
  return out;
}

// Inject the (possibly converted) files into the upload by swapping the hidden
// input's .files and dispatching a trusted-looking change event.
function injectViaInput(input, files) {
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

    // Capture File references now — the FileList may be cleared after the event.
    const originals = Array.from(target.files);
    console.log(TAG, "change intercepted:", originals.map((f) => f.name));
    ev.stopImmediatePropagation();

    processFiles(originals).then((files) => injectViaInput(target, files));
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

    // (a) Convert, then inject through the hidden input.
    const input = findUsableFileInput();
    if (!input) {
      console.warn(TAG, "drop: no usable <input type=file> to swap into");
      return;
    }
    processFiles(originals).then((converted) => injectViaInput(input, converted));
  },
  true
);

// ----------------------------------------------------------------- paste ---
// ClipboardEvent.clipboardData is read-only in Chrome — can't be set via the
// constructor — so a clean synthetic-paste redispatch isn't possible. For now
// we just block file-paste; proper handling is later work.
document.addEventListener(
  "paste",
  (ev) => {
    if (ev[SENTINEL]) return;
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    if (!Array.from(items).some((it) => it.kind === "file")) return;

    console.log(TAG, "paste with files intercepted (blocked, not yet re-injected)");
    ev.preventDefault();
    ev.stopImmediatePropagation();
  },
  true
);

console.log(TAG, "intercept installed at", location.href);
