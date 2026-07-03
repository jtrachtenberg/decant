// In-browser PPTX engine (shape A) — no library covers PPTX the way mammoth
// covers DOCX or SheetJS covers XLSX, so this is a small custom extractor:
// jszip opens the OOXML package and each ppt/slides/slideN.xml is mined for
// text with targeted patterns.
//
// Deliberately pattern-based, not a full XML parse: DOMParser doesn't exist
// in Node (where the tests run), and the DrawingML we need is narrow and
// stable — PowerPoint, Google Slides, and Keynote exports all emit the
// standard a:/p: namespace prefixes. The extractor reads:
//   - <a:t> runs, concatenated per paragraph (<a:p>), entities decoded;
//   - <a:pPr lvl="N"> for bullet indent levels (slide body text is lists);
//   - <p:ph type="title"/ctrTitle"> to lift the title into the slide heading;
//   - <a:tbl> tables, rendered via the shared Markdown table renderer;
//   - <p:pic> and chart graphicFrames, counted as visuals.
//
// Presentations are the most visually-driven format Decant handles, so any
// slide deck containing pictures or charts returns "ambiguous" — the user
// chooses Markdown-without-visuals vs. the untouched original, like PDFs and
// DOCX. Text-free decks pass through. Speaker notes are ignored in this
// first cut (often absent, often noise).
//
// analyzePptx() returns the shared { decision, reason, summary, markdown }
// shape, wrapped by resultFromAnalysis() like every other engine.

import JSZipNs from "jszip";
import { rowsToMarkdownTable } from "./xlsx.js";

const JSZip = JSZipNs.default ?? JSZipNs;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-f]+);/gi, (m, e) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

// Concatenated text of every <a:t> run inside one XML fragment.
function runsText(fragment) {
  return decodeEntities(
    [...fragment.matchAll(/<a:t>([^<]*)<\/a:t>|<a:t\/>/g)]
      .map((m) => m[1] ?? "")
      .join("")
  ).trim();
}

// Pure single-slide extractor — exported for direct unit testing.
// Returns { title, bullets: [{ level, text }], tables: [rows], images,
// omitted: ["[image omitted: Picture 2]", "[chart omitted]", …] } — ready
// markers that make the dropped visuals visible in the converted output.
export function extractSlideText(xml) {
  const omitted = [];
  for (const pic of xml.matchAll(/<p:pic[\s>][\s\S]*?<\/p:pic>/g)) {
    // The drawing's cNvPr carries a human name ("Picture 2", often the
    // original filename) and sometimes a descr (alt text).
    const name = /<p:cNvPr[^>]*\bname="([^"]*)"/.exec(pic[0])?.[1];
    const descr = /<p:cNvPr[^>]*\bdescr="([^"]*)"/.exec(pic[0])?.[1];
    const label = decodeEntities(descr || name || "");
    omitted.push(label ? `[image omitted: ${label}]` : "[image omitted]");
  }
  // Charts are counted from actual graphicData uses only — real producers
  // declare xmlns:c="…drawingml/2006/chart" on EVERY slide whether or not a
  // chart exists (caught by QA on a real Google Slides export), so a bare
  // string match false-positives the ambiguous prompt on chart-free decks.
  for (let i = 0; i < (xml.match(/<a:graphicData[^>]*uri="[^"]*drawingml\/2006\/chart"/g) || []).length; i++) {
    omitted.push("[chart omitted]");
  }
  const images = omitted.length;

  // Tables first, and blank them out so their runs don't re-appear as bullets.
  const tables = [];
  xml = xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<a:tr[\s>][\s\S]*?<\/a:tr>/g)].map((tr) =>
      [...tr[0].matchAll(/<a:tc[\s>][\s\S]*?<\/a:tc>/g)].map((tc) => runsText(tc[0]))
    );
    if (rows.length) tables.push(rows);
    return "";
  });

  let title = "";
  const bullets = [];
  for (const shape of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const sp = shape[0];
    const isTitle = /<p:ph [^>]*type="(?:title|ctrTitle)"/.test(sp);
    for (const para of sp.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g)) {
      const text = runsText(para[0]);
      if (!text) continue;
      if (isTitle && !title) {
        title = text;
      } else {
        const lvl = /<a:pPr[^>]*\blvl="(\d+)"/.exec(para[0]);
        bullets.push({ level: lvl ? Number(lvl[1]) : 0, text });
      }
    }
  }
  return { title, bullets, tables, images, omitted };
}

export async function analyzePptx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));

  const sections = [];
  let images = 0;
  let chars = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    const slide = extractSlideText(await zip.file(slidePaths[i]).async("string"));
    images += slide.images;

    const parts = [];
    for (const b of slide.bullets) parts.push(`${"  ".repeat(b.level)}- ${b.text}`);
    const bulletBlock = parts.join("\n");
    const tableBlocks = slide.tables.map(rowsToMarkdownTable).filter(Boolean);
    // Visible markers for the slide's dropped visuals — evidence in the
    // artifact itself, for the reader and the model alike. Markers don't
    // count toward `chars`, so an image-only deck still passes through.
    const omittedBlock = slide.omitted.join("\n");
    const body = [bulletBlock, ...tableBlocks, omittedBlock]
      .filter(Boolean)
      .join("\n\n");

    chars += slide.title.length + bulletBlock.length + tableBlocks.join("").length;
    if (slide.title || body) {
      const heading = slide.title ? `## Slide ${i + 1}: ${slide.title}` : `## Slide ${i + 1}`;
      sections.push(body ? `${heading}\n\n${body}` : heading);
    }
  }

  const summary = { slides: slidePaths.length, images, chars };
  if (!sections.length || chars === 0) {
    return { decision: "passthrough", reason: "no-text", summary, markdown: null };
  }
  const markdown = sections.join("\n\n") + "\n";
  if (images > 0) {
    return { decision: "ambiguous", reason: "text-with-images", summary, markdown };
  }
  return { decision: "convert", reason: "text", summary, markdown };
}
