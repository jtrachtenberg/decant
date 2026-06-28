// Shape A converter: in-browser PDF → Markdown via pdf.js.
//
// Deliberately naive for Milestone 1 — extract the text layer, reconstruct
// lines from glyph positions, and detect paragraph breaks from vertical gaps.
// No heading or table structure yet; that comes once we see real output.
//
// The text-layer check is the important guardrail: a scanned / image-only PDF
// has little or no extractable text, and converting it would silently throw
// away everything the model needs. Such files are reported as low-text so the
// caller passes the original through untouched.

import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

// Below this average extractable characters per page, assume the PDF is
// scanned / image-only and should pass through rather than be converted.
const MIN_CHARS_PER_PAGE = 50;

export async function pdfToMarkdown(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  const pages = [];
  let totalChars = 0;
  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      totalChars += text.length;
      pages.push(text);
    }
  } finally {
    // destroy() lives on the loading task in pdf.js v6; it tears down the
    // document and the worker connection.
    await loadingTask.destroy();
  }

  const avgChars = totalChars / Math.max(pageCount, 1);
  if (avgChars < MIN_CHARS_PER_PAGE) {
    return { ok: false, reason: "low-text", pageCount, avgChars };
  }

  const markdown = pages.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return { ok: true, markdown, pageCount, avgChars };
}

// Reconstruct readable text from positioned glyph runs. pdf.js gives each run
// a transform matrix: [4] is x, [5] is y (origin bottom-left, so larger y is
// higher on the page). We sort top-to-bottom then left-to-right, group runs
// into lines by y proximity, insert spaces on horizontal gaps, and break
// paragraphs on large vertical gaps.
function itemsToText(items) {
  const glyphs = items.filter(
    (it) => typeof it.str === "string" && it.str.length
  );
  if (!glyphs.length) return "";

  glyphs.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > 2) return dy;
    return a.transform[4] - b.transform[4];
  });

  const lines = [];
  for (const g of glyphs) {
    const x = g.transform[4];
    const y = g.transform[5];
    const w = g.width || 0;
    const h = g.height || 10;
    const last = lines[lines.length - 1];

    if (last && Math.abs(y - last.y) <= h * 0.5) {
      const gap = x - last.endX;
      const needsSpace =
        gap > h * 0.25 && !/\s$/.test(last.text) && !/^\s/.test(g.str);
      last.text += (needsSpace ? " " : "") + g.str;
      last.endX = x + w;
      last.y = (last.y + y) / 2;
    } else {
      const para = last ? last.y - y > h * 1.6 : false;
      lines.push({ y, endX: x + w, text: g.str, para });
    }
  }

  let out = "";
  lines.forEach((line, i) => {
    const text = line.text.replace(/[ \t]+/g, " ").trim();
    if (!text) return;
    if (i > 0) out += line.para ? "\n\n" : "\n";
    out += text;
  });
  return out;
}
