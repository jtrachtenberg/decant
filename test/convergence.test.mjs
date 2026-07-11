// Unit tests for the Tier 2 column-clustering convergence signal
// (classify.js: columnConvergence). Pure — each case is a synthetic set of
// reconstructed lines (only cell.x and line.h matter to the metric), so the
// three profiles it must separate are isolated from pdf.js reconstruction:
//   - left-aligned prose      → one busy band          → high
//   - a clean multi-col table → one band per column     → high
//   - scattered chart labels  → many weak bands         → low
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnConvergence,
  CONVERGENCE_MIN_CELLS,
} from "../src/convert/classify.js";

// Minimal line object: the metric only reads `h` and `cells[].x`.
const line = (h, ...xs) => ({ h, cells: xs.map((x) => ({ x, text: "c" })) });

test("left-aligned prose converges (all starts share the left margin)", () => {
  const lines = [];
  for (let i = 0; i < 15; i++) lines.push(line(10, i % 2)); // x ≈ 0, tiny jitter
  const { score, columns } = columnConvergence(lines);
  assert.equal(columns, 1);
  assert.ok(score >= 0.9, `prose should converge, got ${score}`);
});

test("a clean 3-column table converges (one band per column)", () => {
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(line(10, 0, 120, 180));
  const { score, columns } = columnConvergence(lines);
  assert.equal(columns, 3);
  assert.ok(score >= 0.9, `table columns should converge, got ${score}`);
});

test("clean two-column prose converges (each margin is a well-supported band)", () => {
  // The page-19 regression: two-column body text reflows correctly, so its
  // lines begin at one of two recurring margins. A top-K-bands measure counted
  // only the busier column and capped this at ~0.5 (false positive); scoring by
  // support counts both columns, so genuinely clean two-column prose scores ~1.
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(line(10, 50)); // left column
  for (let i = 0; i < 20; i++) lines.push(line(10, 300)); // right column
  const { score, columns } = columnConvergence(lines);
  assert.equal(columns, 2);
  assert.ok(score >= 0.9, `two-column prose should converge, got ${score}`);
});

test("scattered chart labels do not converge", () => {
  // Fifteen labels strewn across the x-axis with no repeated start position —
  // the fingerprint of a flattened chart. Their starts spread across many
  // single-support bands, so the K busiest bands cover only a small fraction.
  const xs = [4, 41, 77, 118, 152, 190, 233, 268, 305, 349, 388, 421, 466, 502, 540];
  const lines = xs.map((x) => line(10, x));
  const { score } = columnConvergence(lines);
  assert.ok(score <= 0.4, `chart-label soup should score low, got ${score}`);
});

test("a title page of stacked centered headings is not judged (sparse guard)", () => {
  // The clean-text page-34 regression: a divider page of a handful of
  // centered headings. Each line starts where its own width dictates, so no
  // start band ever recurs — starts-only scoring gave this 0.00 and attached
  // the page as a flattened chart. Sparse pages carry too few cells to be
  // label soup (and lose almost nothing as text), so the min-cells floor
  // clears them instead of the metric judging them.
  const xs = [275, 238, 192, 258, 145, 215, 170, 229];
  const { score } = columnConvergence(xs.map((x) => line(14, x)));
  assert.equal(score, 1);
  assert.ok(xs.length < CONVERGENCE_MIN_CELLS);
});

test("prose clearly outscores chart-label soup (the signal is separable)", () => {
  const prose = [];
  for (let i = 0; i < 14; i++) prose.push(line(10, i % 3));
  const soup = [
    10, 55, 92, 140, 188, 231, 279, 330, 372, 419, 463, 508, 551, 598,
  ].map((x) => line(10, x));
  assert.ok(columnConvergence(prose).score - columnConvergence(soup).score >= 0.4);
});

test("a sparse fragment reports full confidence (too little to judge)", () => {
  const { score } = columnConvergence([line(10, 0), line(10, 40)]);
  assert.equal(score, 1); // fewer than CONVERGENCE_MIN_CELLS cells
  assert.ok(CONVERGENCE_MIN_CELLS > 2);
});

test("no content lines → zero columns, full confidence", () => {
  assert.deepEqual(columnConvergence([]), { score: 1, columns: 0, bands: 0 });
  assert.deepEqual(columnConvergence([{ marker: true, cells: [{ x: 0 }] }]), {
    score: 1,
    columns: 0,
    bands: 0,
  });
});
