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
//   - SmartArt: the text of its diagram data part, as bullets;
//   - <p:pic> pictures, and charts, diagrams and other graphic frames (OLE
//     objects, chartEx) we can't read, counted as visuals with a marker.
// Slides come in presentation order (presentation.xml's sldIdLst), and hidden
// slides are labelled "(hidden)".
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
// omitted: ["[image omitted: Picture 2]", …], chartRefs: ["rId2", …],
// diagramRefs: ["rId5", …], hidden }. `images`/`omitted` cover pictures and
// unreadable graphic frames (OLE objects, chartEx); charts and SmartArt are
// returned as references and resolved to data (or a marker) in analyzePptx,
// which holds the zip. `hidden` is the slide's show="0" flag.
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

  // SmartArt: the slide holds only a graphicFrame whose dgm:relIds point at the
  // diagram's data part (ppt/diagrams/dataN.xml), where the text lives; the
  // r:dm reference is resolved to that text in analyzePptx (B7).
  const diagramRefs = [...xml.matchAll(/<dgm:relIds\b[^>]*\br:dm="([^"]+)"/g)].map(
    (m) => m[1]
  );

  // Any other graphicFrame — an OLE object, an Office 2016 chartEx — carries no
  // text this extractor can read. Mark it and count it as a visual so the
  // slide prompts rather than losing it silently (B7). mc:Choice branches are
  // skipped: their mc:Fallback (usually a picture, counted above) stands in.
  const outsideChoice = xml.replace(/<mc:Choice\b[\s\S]*?<\/mc:Choice>/g, "");
  for (const frame of outsideChoice.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)) {
    const uri = /<a:graphicData\b[^>]*\buri="([^"]*)"/.exec(frame[0])?.[1] ?? "";
    // Tables, charts and SmartArt are handled elsewhere; a frame naming no
    // graphic type at all isn't evidence of a lost visual.
    if (!uri || /\/(?:table|chart|diagram)$/.test(uri)) continue;
    if (/<a:tbl[\s>]|<c:chart\b|<dgm:relIds\b/.test(frame[0])) continue;
    if (/chartex$/i.test(uri)) {
      omitted.push("[chart omitted]");
      continue;
    }
    const name = /<p:cNvPr[^>]*\bname="([^"]*)"/.exec(frame[0])?.[1];
    const label = escapeMarkerLabel(decodeEntities((name || "").trim()));
    omitted.push(label ? `[object omitted: ${label}]` : "[object omitted]");
  }
  // Also pick up a chartEx that sits in an mc:Choice with no fallback picture.
  for (const alt of xml.matchAll(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g)) {
    if (/chartex"/i.test(alt[0]) && !/<mc:Fallback\b[\s\S]*?<p:pic[\s>]/.test(alt[0])) {
      omitted.push("[chart omitted]");
    }
  }

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
  const hidden = /<p:sld\b[^>]*\bshow="(?:0|false)"/.test(xml);
  return { title, bullets, tables, images: omitted.length, omitted, chartRefs, diagramRefs, hidden };
}

// --- Per-slide chart reference resolution (parser lives in chart.js) --------

// Map rId → resolved chart-part path for one slide, from its .rels file.
async function slideChartTargets(zip, slidePath) {
  const relsPath = slidePath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsFile = zip.file(relsPath);
  if (!relsFile) return {};
  return relTargets(slidePath, await relsFile.async("string"));
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

// The deck's slides in presentation order: ppt/presentation.xml <p:sldIdLst>
// resolved through its .rels (B8). Part filenames usually follow that order
// but needn't — other producers, and decks reordered without renaming, keep
// the old numbers. Falls back to filename order when the package has no
// usable slide list.
async function slideOrder(zip) {
  const byName = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));
  try {
    const pres = zip.file("ppt/presentation.xml");
    const rels = zip.file("ppt/_rels/presentation.xml.rels");
    if (!pres || !rels) return byName;
    const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(await pres.async("string"))?.[1];
    if (!list) return byName;
    const targets = relTargets("ppt/presentation.xml", await rels.async("string"));
    const ordered = [...list.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
      .map((m) => targets[m[1]])
      .filter((p) => p && zip.file(p));
    return ordered.length ? [...new Set(ordered)] : byName;
  } catch {
    return byName;
  }
}

// Map rId → resolved package path, from one part's .rels XML.
function relTargets(ownerPath, relsXml) {
  const map = {};
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) map[id] = resolveRelTarget(ownerPath, target);
  }
  return map;
}

// The text of a SmartArt diagram's data part, one entry per paragraph, in the
// data model's point order.
function diagramText(dataXml) {
  return [...dataXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
    .map((p) => runsText(p[0]))
    .filter(Boolean);
}

export async function analyzePptx(file) {
  const zip = await JSZip.loadAsync(await fileBytes(file));
  const slidePaths = await slideOrder(zip);

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
    const targets =
      slide.chartRefs.length || slide.diagramRefs.length
        ? await slideChartTargets(zip, slidePath)
        : {};
    if (slide.chartRefs.length) {
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
    // SmartArt text is content: recover it as bullets (B7). A diagram whose
    // data part can't be read or holds no text is marked and prompts.
    const diagramBullets = [];
    for (const rId of slide.diagramRefs) {
      const part = targets[rId] && zip.file(targets[rId]);
      let texts = [];
      try {
        texts = part ? diagramText(await part.async("string")) : [];
      } catch {
        texts = [];
      }
      if (texts.length) diagramBullets.push(...texts.map((text) => ({ level: 0, text })));
      else chartOmitted.push("[diagram omitted]");
    }
    images += slide.images + chartOmitted.length;

    const parts = [];
    for (const b of [...slide.bullets, ...diagramBullets]) {
      parts.push(`${"  ".repeat(b.level)}- ${escapeMdInline(b.text)}`);
    }
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
      // A hidden slide is still content, but not what the audience sees —
      // say so rather than present it as a normal slide (B8).
      const n = `${i + 1}${slide.hidden ? " (hidden)" : ""}`;
      const heading = slide.title
        ? `## Slide ${n}: ${escapeMdInline(slide.title)}`
        : `## Slide ${n}`;
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
