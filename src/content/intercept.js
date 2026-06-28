// Decant — Milestone 0: hardcoded Markdown swap.
//
// Listens for file-attach events on claude.ai and substitutes a fixed
// `hello.md` for whatever the user actually selected. The point is not
// conversion — it's to prove that interception + substitution lands at all.
//
// Three attach paths:
//   1. <input type="file"> change   (file-picker / paperclip button)
//   2. drop                          (drag-and-drop onto the composer)
//   3. paste                         (file pasted from clipboard) — TODO
//
// All listeners are installed in the capture phase at document_start so they
// run before Claude's own handlers. stopImmediatePropagation then keeps the
// original event from reaching them; we re-dispatch synthetic events carrying
// the swapped file (and, on drop, a separate cleanup event to release the
// dropzone overlay — see drop handler).

const TAG = "[decant]";
const SENTINEL = "__decantSynthetic";

const HELLO_MD =
  "# Hello from Decant\n" +
  "\n" +
  "If you can read this in the chat, the file-swap path works.\n" +
  "The file you originally picked never left your machine.\n";

function makeMarkdownFile(name) {
  return new File([HELLO_MD], name || "hello.md", { type: "text/markdown" });
}

function dataTransferWith(file) {
  const dt = new DataTransfer();
  dt.items.add(file);
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

// ---------------------------------------------------------------- change ---
document.addEventListener(
  "change",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "file") return;
    if (ev[SENTINEL]) return;
    if (!target.files || target.files.length === 0) return;

    console.log(TAG, "change intercepted:", Array.from(target.files, (f) => f.name));
    ev.stopImmediatePropagation();

    target.files = dataTransferWith(makeMarkdownFile()).files;
    const synth = new Event("change", { bubbles: true, cancelable: true });
    synth[SENTINEL] = true;
    target.dispatchEvent(synth);
  },
  true
);

// ------------------------------------------------------------------ drop ---
// Two synthesized events are needed on Claude:
//   (a) populate the hidden <input type="file"> and dispatch a change event.
//       This is what reliably adds the file to the composer; a synthetic
//       DragEvent on the dropzone alone isn't trusted as a file source.
//   (b) dispatch a synthetic drop on the original target so Claude's drop
//       handler runs and clears its "drag active" state (the overlay).
//       Empty dataTransfer makes the handler bail before resetting state,
//       so the cleanup drop has to carry a file (which Claude then ignores
//       because isTrusted === false). Net result: overlay clears, no dup.
document.addEventListener(
  "drop",
  (ev) => {
    if (ev[SENTINEL]) return;
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || files.length === 0) return;

    console.log(TAG, "drop intercepted:", Array.from(files, (f) => f.name));
    ev.preventDefault();
    ev.stopImmediatePropagation();

    const input = findUsableFileInput();
    if (input) {
      input.files = dataTransferWith(makeMarkdownFile()).files;
      const change = new Event("change", { bubbles: true, cancelable: true });
      change[SENTINEL] = true;
      input.dispatchEvent(change);
    } else {
      console.warn(TAG, "drop: no usable <input type=file> to swap into");
    }

    const cleanupDrop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransferWith(makeMarkdownFile()),
      clientX: ev.clientX,
      clientY: ev.clientY,
    });
    cleanupDrop[SENTINEL] = true;
    ev.target.dispatchEvent(cleanupDrop);
  },
  true
);

// ----------------------------------------------------------------- paste ---
// ClipboardEvent.clipboardData is read-only in Chrome — can't be set via the
// constructor — so a clean synthetic-paste redispatch isn't possible. For
// Milestone 0 we just block file-paste; proper handling is M1+ work.
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
