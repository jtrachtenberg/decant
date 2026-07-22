// Markdown-output helpers shared by every engine.
//
// These are engine-agnostic string functions, kept out of any one engine on
// purpose: they used to live in xlsx.js, which meant the HTML engine (and so
// the page-capture bundle injected into arbitrary pages, SPEC §3.11) pulled
// the whole spreadsheet module graph — SheetJS and JSZip — along with an
// eight-line string helper.

// Sanitize document-supplied text (image alt / drawing descr / name) for use
// INSIDE an `[image omitted: …]` marker. Three hazards: a literal `]` closes
// the marker early and defeats the `\[image omitted[^\]]*\]` stripping regex
// (marker residue then counts as "real text", flipping a pure-image doc from
// passthrough to convert); a newline injects a structural line (a decoded
// `&#10;` in a DrawingML descr can smuggle a `# heading`); and a `|` breaks a
// GFM row if the marker lands in a table cell. Brackets are dropped, newlines
// collapse, pipes are escaped. Exported for direct unit testing.
export function escapeMarkerLabel(text) {
  return String(text ?? "")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}
