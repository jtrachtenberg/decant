// Input-size ceilings for the in-browser engines (B4 / S8; the July review's
// L15). Every engine runs in the chat tab's renderer, and an out-of-memory
// there is a fatal tab crash, not a catchable error — the passthrough
// guarantee can't help once the heap is gone. A 792 KB DOCX whose
// document.xml inflates to 272 MB took the process down after ~54 s.
//
// Measured cost (Node, mammoth): 10 MB of document XML ≈ 0.9 GB peak and ~7 s;
// 25 MB ≈ 2.9 GB and ~22 s. Parsed markup (OOXML parts, HTML) is what costs,
// so it gets the tight cap; media inside a package is only copied.
//
// Over any ceiling the file passes through untouched (reason "too-large"):
// the original still uploads, it just isn't converted. Pure except for reading
// slices of the File, so it unit-tests in Node (test/limits.test.mjs).

import { fileBytes } from "./read-file.js";

// Raw file size any in-browser engine will open.
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
// Parsed markup: the summed inflated size of a package's .xml/.rels parts, or
// an HTML file's size.
export const MAX_MARKUP_BYTES = 16 * 1024 * 1024;
// Everything a package inflates to, media included.
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const EOCD_LEN = 22;
const MAX_COMMENT = 0xffff;
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

// Read a zip's central directory from the File's tail — no inflation, and only
// the directory bytes are read. Returns:
//   null                     not a zip (no end-of-central-directory record),
//                            e.g. a legacy CFB .xls — nothing to check;
//   { entries: [{name, size}] }  declared inflated sizes (Infinity for zip64);
//   { unreadable: true }     it claims to be a zip but the directory doesn't
//                            parse — refuse rather than let an engine guess.
// Declared sizes are trustworthy for the JSZip-based engines: JSZip rejects an
// entry whose inflated length differs from its header ("uncompressed data size
// mismatch") before any XML is parsed.
export async function zipEntrySizes(file) {
  const size = file.size;
  if (size < EOCD_LEN) return null;
  // A legacy .xls is an OLE compound file: never a zip, whatever bytes its
  // tail happens to hold.
  const head = new Uint8Array(await fileBytes(file.slice(0, 4)));
  if (CFB_MAGIC.every((b, i) => head[i] === b)) return null;
  const tailLen = Math.min(size, EOCD_LEN + MAX_COMMENT);
  const tailStart = size - tailLen;
  const tail = new DataView(await fileBytes(file.slice(tailStart, size)));
  let eocd = -1;
  for (let i = tailLen - EOCD_LEN; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { entries: [{ name: "(zip64)", size: Infinity }] };
  }
  // Tolerate bytes prepended to the archive (as JSZip does): the directory
  // really ends where the EOCD record starts.
  const eocdAbs = tailStart + eocd;
  const shift = eocdAbs - (cdOffset + cdSize);
  if (shift < 0) return { unreadable: true };
  cdOffset += shift;

  const cd = new Uint8Array(await fileBytes(file.slice(cdOffset, cdOffset + cdSize)));
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  let p = 0;
  while (entries.length < count) {
    if (p + 46 > cd.length || view.getUint32(p, true) !== CDH_SIG) {
      return { unreadable: true };
    }
    const declared = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, size: declared === 0xffffffff ? Infinity : declared });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

const isMarkupPart = (name) => /\.(xml|rels)$/i.test(name);

// A passthrough analysis for `file` ("too-large", or "bad-zip" for a package
// whose directory can't be read), or null when every ceiling holds. `kind` is "zip" for OOXML packages, "markup" for HTML, else raw only.
export async function sizeVerdict(file, kind) {
  const tooLarge = (detail, reason = "too-large") => ({
    decision: "passthrough",
    reason,
    summary: { bytes: file.size, ...detail },
    markdown: null,
  });

  if (file.size > MAX_INPUT_BYTES) return tooLarge({ limit: "input" });
  if (kind === "markup" && file.size > MAX_MARKUP_BYTES) {
    return tooLarge({ limit: "markup" });
  }
  if (kind !== "zip") return null;

  const zip = await zipEntrySizes(file);
  if (!zip) return null;
  if (zip.unreadable) return tooLarge({ limit: "zip-directory" }, "bad-zip");
  let inflated = 0;
  let markup = 0;
  for (const e of zip.entries) {
    inflated += e.size;
    if (isMarkupPart(e.name)) markup += e.size;
  }
  if (markup > MAX_MARKUP_BYTES) return tooLarge({ limit: "markup", inflated, markup });
  if (inflated > MAX_INFLATED_BYTES) return tooLarge({ limit: "inflated", inflated, markup });
  return null;
}
