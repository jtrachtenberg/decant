// In-browser PPTX engine (shape A) — no library covers PPTX the way mammoth
// covers DOCX or SheetJS covers XLSX, so this is a small custom extractor:
// jszip opens the OOXML package and each ppt/slides/slideN.xml is mined for
// text with targeted patterns.
//
// Deliberately pattern-based, not a full XML parse: DOMParser doesn't exist
// in Node (where the tests run), and the DrawingML we need is narrow and
// stable — PowerPoint, Google Slides, and Keynote exports all emit the
// standard a:/p:/c: namespace prefixes. The extractor reads:
//   - <a:t> runs, concatenated per paragraph (<a:p>), entities decoded;
//   - <a:pPr lvl="N"> for bullet indent levels (slide body text is lists);
//   - <p:ph type="title"/ctrTitle"> to lift the title into the slide heading;
//   - <a:tbl> tables, rendered via the shared Markdown table renderer;
//   - native charts: a chart isn't an image — its chart part stores the cached
//     data series (<c:ser> → c:tx/c:cat/c:val), so we resolve the reference and
//     emit a real Markdown table (Tier 1, SPEC §3.9). Deterministic, OCR-free,
//     often better than the source for a model;
//   - <p:pic> pictures, and charts we can't parse, counted as visuals.
//
// Presentations are the most visually-driven format Decant handles, so a slide
// with pictures (or a chart whose data we couldn't recover) returns "ambiguous"
// — the user chooses Markdown-without-visuals vs. the untouched original, like
// PDFs and DOCX. A deck whose only visuals are recovered charts converts
// cleanly. Text-free decks pass through. Speaker notes are ignored (first cut).
//
// analyzePptx() returns the shared { decision, reason, summary, markdown }
// shape, wrapped by resultFromAnalysis() like every other engine.

import JSZipNs from "jszip";
import { fileBytes } from "./read-file.js";
import { rowsToMarkdownTable, escapeMdInline } from "./xlsx.js";
import { escapeMarkerLabel } from "./markdown.js";
import { decodeEntities, parseChartXml } from "./chart.js";

const JSZip = JSZipNs.default ?? JSZipNs;

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
// omitted: ["[image omitted: Picture 2]", …], chartRefs: ["rId2", …] }.
// `images`/`omitted` cover pictures only; charts are returned as references
// and resolved to data (or a marker) in analyzePptx, which holds the zip.
export function extractSlideText(xml) {
  const omitted = [];
  for (const pic of xml.matchAll(/<p:pic[\s>][\s\S]*?<\/p:pic>/g)) {
    // The drawing's cNvPr carries a human name ("Picture 2", often the
    // original filename) and sometimes a descr (alt text).
    const name = /<p:cNvPr[^>]*\bname="([^"]*)"/.exec(pic[0])?.[1];
    const descr = /<p:cNvPr[^>]*\bdescr="([^"]*)"/.exec(pic[0])?.[1];
    // Missing, empty, and whitespace-only descr/name all fall through to the
    // generic marker; descr (alt text) wins over name when both are real.
    const label = escapeMarkerLabel(
      decodeEntities((descr || "").trim() || (name || "").trim() || "")
    );
    omitted.push(label ? `[image omitted: ${label}]` : "[image omitted]");
  }

  // Chart references: <c:chart r:id="rIdN"/> inside a chart graphicFrame. Only
  // a real c:chart reference counts — producers declare xmlns:c on every slide
  // whether or not a chart exists, so matching the bare namespace string
  // false-positives (was a real bug). The r:id resolves via the slide .rels in
  // analyzePptx to the chart part whose cached data becomes a table.
  const chartRefs = [...xml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map(
    (m) => m[1]
  );

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
  return { title, bullets, tables, images: omitted.length, omitted, chartRefs };
}

// --- Per-slide chart reference resolution (parser lives in chart.js) --------

// Map rId → resolved chart-part path for one slide, from its .rels file.
async function slideChartTargets(zip, slidePath) {
  const relsPath = slidePath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsFile = zip.file(relsPath);
  if (!relsFile) return {};
  const rels = await relsFile.async("string");
  const map = {};
  for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) map[id] = resolveRelTarget(slidePath, target);
  }
  return map;
}

// Resolve a relationship Target (relative to its owning part) to a package
// path: base "ppt/slides/slide1.xml" + "../charts/chart1.xml" →
// "ppt/charts/chart1.xml". A leading "/" means package-absolute.
function resolveRelTarget(ownerPath, target) {
  if (target.startsWith("/")) return target.slice(1);
  const segs = ownerPath.replace(/\/[^/]*$/, "").split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") segs.pop();
    else if (seg && seg !== ".") segs.push(seg);
  }
  return segs.join("/");
}

export async function analyzePptx(file) {
  const zip = await JSZip.loadAsync(await fileBytes(file));
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));

  const sections = [];
  let images = 0;
  let chartsRecovered = 0;
  let chars = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i];
    const slide = extractSlideText(await zip.file(slidePath).async("string"));

    // Recover each referenced chart's cached data into a table; a chart we
    // can't resolve or parse becomes a [chart omitted] marker and counts as a
    // visual (so the slide still prompts).
    const chartTables = [];
    const chartOmitted = [];
    if (slide.chartRefs.length) {
      const targets = await slideChartTargets(zip, slidePath);
      for (const rId of slide.chartRefs) {
        const part = targets[rId] && zip.file(targets[rId]);
        // A bad chart part (corrupt deflate / unparseable XML) must not abort
        // the whole deck: treat it as an omitted chart, like an unresolved ref.
        let parsed = null;
        try {
          parsed = part ? parseChartXml(await part.async("string")) : null;
        } catch {
          parsed = null;
        }
        if (parsed) {
          chartsRecovered++;
          const label = parsed.title ? `**${escapeMdInline(parsed.title)}**\n\n` : "";
          chartTables.push(label + rowsToMarkdownTable(parsed.rows));
        } else {
          chartOmitted.push("[chart omitted]");
        }
      }
    }
    images += slide.images + chartOmitted.length;

    const parts = [];
    for (const b of slide.bullets) parts.push(`${"  ".repeat(b.level)}- ${escapeMdInline(b.text)}`);
    const bulletBlock = parts.join("\n");
    const tableBlocks = slide.tables.map(rowsToMarkdownTable).filter(Boolean);
    // Omission markers are visible evidence but not content; recovered chart
    // tables ARE content and count toward chars (so a chart-only slide converts).
    const omittedBlock = [...slide.omitted, ...chartOmitted].join("\n");
    const body = [bulletBlock, ...tableBlocks, ...chartTables, omittedBlock]
      .filter(Boolean)
      .join("\n\n");

    chars +=
      slide.title.length +
      bulletBlock.length +
      tableBlocks.join("").length +
      chartTables.join("").length;
    if (slide.title || body) {
      const heading = slide.title
        ? `## Slide ${i + 1}: ${escapeMdInline(slide.title)}`
        : `## Slide ${i + 1}`;
      sections.push(body ? `${heading}\n\n${body}` : heading);
    }
  }

  const summary = { slides: slidePaths.length, images, chartsRecovered, chars };
  if (!sections.length || chars === 0) {
    return { decision: "passthrough", reason: "no-text", summary, markdown: null };
  }
  const markdown = sections.join("\n\n") + "\n";
  if (images > 0) {
    return { decision: "ambiguous", reason: "text-with-images", summary, markdown };
  }
  return { decision: "convert", reason: "text", summary, markdown };
}
