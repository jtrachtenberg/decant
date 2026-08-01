// Dev tool: sweep a corpus directory and diff two revisions of the engine.
//
//   node scripts/sweep-corpus.mjs scan <corpus-dir> <out.json>
//   node scripts/sweep-corpus.mjs diff <before.json> <after.json>
//
// inspect-pdf.mjs answers "what does Decant do with THIS file"; this answers
// "what changed across the corpus", which is the question an ADR's Consequences
// table has to answer before a structural change is Accepted. Scan on each
// revision (the script is revision-independent — keep it untracked or copy it
// across the checkout), then diff the two JSONs.
//
// Everything recorded comes from the same shared analyzePdf() engine the
// extension and the CLI run, observed through its onPage seam — a parallel
// re-derivation drifts (see the header of inspect-pdf.mjs for the time it did).
//
// Expects the decantCC corpus layout: <corpus-dir>/<doc>/source.pdf.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { installNodeAssets } from "../src/cli/node-assets.js";
import { columnConvergence, selectChartPages } from "../src/convert/classify.js";
import { MAX_SUBSET_PAGES } from "../src/convert/pdf-subset.js";

installNodeAssets();
const { analyzePdf } = await import("../src/convert/inbrowser.js");

// Tier 2 QA (SPEC §3.9), same constants inspect-pdf.mjs sweeps with.
// (CONVERGENCE_MIN_CELLS is applied inside columnConvergence, which returns a
// clean 1 below the floor, so a threshold test here is the whole gate.)
const CONV_THRESHOLD = Number(process.env.CONV_THRESHOLD || 0.5);

const sha = (s) => createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);

// --- scan -------------------------------------------------------------------

async function scanDoc(name, path) {
  const buf = await readFile(path);
  const pages = [];
  const { decision, reason, summary } = await analyzePdf(
    new File([buf], basename(path), { type: "application/pdf" }),
    {
      onPage(p) {
        const conv = columnConvergence(p.lines);
        // Every unreliability marker the page carries, by its own text — the
        // pre-existing "low structural confidence" table marker, the garbled
        // text-layer marker, the tiny-prop-text marker. Counting the texts
        // rather than a boolean keeps a marker that CHANGES KIND visible.
        const markers = p.lines
          .filter((l) => l.marker)
          .map((l) => (l.cells[0]?.text || "").slice(0, 60));
        pages.push({
          page: p.page,
          chars: p.signals.chars,
          conv: Number(conv.score.toFixed(4)),
          columns: conv.columns,
          bands: conv.bands,
          markers,
          vectorChart: !!p.vectorChart,
          symbolKey: !!p.symbolPlan,
          md: sha(p.markdown),
          mdLen: (p.markdown || "").length,
        });
      },
    }
  );
  const attached = summary.chartPageNumbers?.length
    ? selectChartPages(summary, MAX_SUBSET_PAGES)
    : [];
  return {
    name,
    decision,
    reason,
    pageCount: summary.pageCount,
    contentPages: summary.contentPages,
    chartPages: summary.chartPages,
    totalChars: summary.totalChars,
    chartPageNumbers: summary.chartPageNumbers ?? [],
    flattenedPageNumbers: summary.flattenedPageNumbers ?? [],
    attached,
    doc: sha(pages.map((p) => p.md).join("\n")),
    pages,
  };
}

async function scan(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  const docs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(dir, e.name, "source.pdf");
    try {
      await readFile(path, { flag: "r" });
    } catch {
      continue; // no source.pdf — not a corpus document
    }
    process.stderr.write(`scanning ${e.name} … `);
    const t = process.hrtime.bigint();
    docs.push(await scanDoc(e.name, path));
    process.stderr.write(`${Number(process.hrtime.bigint() - t) / 1e9 | 0}s\n`);
  }
  await writeFile(out, JSON.stringify({ docs }, null, 1));
  console.log(`wrote ${out} — ${docs.length} documents`);
}

// --- diff -------------------------------------------------------------------

// A page counts as flagged when it has real text and converges below threshold.
const flagged = (p) => p.chars >= 50 && p.conv < CONV_THRESHOLD;

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function diff(aPath, bPath) {
  const a = JSON.parse(await readFile(aPath, "utf8"));
  const b = JSON.parse(await readFile(bPath, "utf8"));
  const byName = new Map(a.docs.map((d) => [d.name, d]));

  let rose = 0, fell = 0, newFlag = 0, newClean = 0, changed = 0;
  let markersBefore = 0, markersAfter = 0;
  const detail = [];
  const docRows = [];

  for (const db of b.docs) {
    const da = byName.get(db.name);
    if (!da) {
      docRows.push([db.name, "—", "(new)"]);
      continue;
    }
    let docChanged = 0;
    const pa = new Map(da.pages.map((p) => [p.page, p]));
    for (const p of db.pages) {
      const q = pa.get(p.page);
      if (!q) continue;
      markersBefore += q.markers.length;
      markersAfter += p.markers.length;
      if (p.md !== q.md) { changed++; docChanged++; }
      const dconv = p.conv - q.conv;
      if (dconv > 0.0001) rose++;
      if (dconv < -0.0001) fell++;
      const fa = flagged(q), fb = flagged(p);
      if (!fa && fb) newFlag++;
      if (fa && !fb) newClean++;
      if (p.md !== q.md || Math.abs(dconv) > 0.0001 || fa !== fb ||
          p.markers.join("|") !== q.markers.join("|")) {
        detail.push({
          doc: db.name, page: p.page,
          conv: `${q.conv.toFixed(2)}→${p.conv.toFixed(2)}`,
          flag: fa === fb ? "" : fb ? "NEWLY FLAGGED" : "newly clean",
          md: p.md === q.md ? "" : `md ${q.mdLen}→${p.mdLen} ch`,
          markers: p.markers.join("|") === q.markers.join("|")
            ? "" : `markers ${q.markers.length}→${p.markers.length}`,
        });
      }
    }
    docRows.push([
      db.name,
      docChanged ? `${docChanged}/${db.pages.length} pages differ` : "byte-identical",
      da.decision === db.decision ? db.decision : `${da.decision}→${db.decision}`,
      da.attached.join(",") === db.attached.join(",")
        ? `attach ${db.attached.length}`
        : `attach ${da.attached.length}→${db.attached.length}`,
    ]);
  }

  console.log(`\nbefore: ${aPath}\nafter:  ${bPath}\n`);
  console.log(pad("", 34) + "count");
  console.log("-".repeat(52));
  console.log(pad("pages whose convergence rose", 34) + rose);
  console.log(pad("pages whose convergence fell", 34) + fell);
  console.log(pad("pages newly flagged low-confidence", 34) + newFlag);
  console.log(pad("pages newly clean", 34) + newClean);
  console.log(pad("unreliability markers", 34) + `${markersBefore} → ${markersAfter}`);
  console.log(pad("pages whose Markdown changed", 34) + changed);
  console.log("-".repeat(52));

  console.log(`\nPer document\n`);
  for (const r of docRows) {
    console.log("  " + pad(r[0], 16) + pad(r[1], 26) + pad(r[2] ?? "", 22) + (r[3] ?? ""));
  }

  if (detail.length) {
    console.log(`\nPages that moved (${detail.length})\n`);
    for (const d of detail) {
      console.log(
        "  " + pad(`${d.doc} p${d.page}`, 24) + pad(d.conv, 14) +
          [d.flag, d.md, d.markers].filter(Boolean).join("  ")
      );
    }
  } else {
    console.log("\nNo page moved: byte-identical across the corpus.");
  }
  console.log();
}

// --- dump -------------------------------------------------------------------

// The drill-down the diff table points at: the emitted Markdown for several
// pages of one document in a single analysis pass, so the two revisions' output
// can be compared with a text diff. inspect-pdf.mjs --page does one page per
// run, which is a whole re-analysis per page of a 98-page scan.
async function dump(path, list) {
  const want = new Set(list.split(",").map((n) => Number(n.trim())));
  const out = [];
  await analyzePdf(new File([await readFile(path)], basename(path), { type: "application/pdf" }), {
    onPage(p) {
      if (!want.has(p.page)) return;
      out.push(`===== page ${p.page} =====\n${p.markdown || "(nothing extracted)"}`);
    },
  });
  console.log(out.join("\n\n"));
}

// --- main -------------------------------------------------------------------

const [mode, one, two] = process.argv.slice(2);
if (mode === "scan" && one && two) await scan(one, two);
else if (mode === "diff" && one && two) await diff(one, two);
else if (mode === "dump" && one && two) await dump(one, two);
else {
  console.error(
    "usage:\n  node scripts/sweep-corpus.mjs scan <corpus-dir> <out.json>\n" +
      "  node scripts/sweep-corpus.mjs diff <before.json> <after.json>\n" +
      "  node scripts/sweep-corpus.mjs dump <file.pdf> <page,page,…>"
  );
  process.exit(1);
}
