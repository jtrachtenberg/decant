// Unit tests for the kind-aware flattened-figure flag (ADR 0031).
//
// `columnConvergence` measures how a page's emitted cells line up. Whether
// that MEANS anything depends on what the page is made of: a chart's label
// soup and a table read badly should align and don't, while a designed layout
// has no reason to share a left edge at all. So a low score only raises the
// marker on a page made of fragments.
//
// The corpus pair that forced it: table-heavy p11 and p33 both score 0.48.
// p11 is clean prose (the marker was wrong); p33 is a Scope 3 table whose
// values came away from their labels (the marker was right).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructPage, linesToMarkdown } from "../src/convert/classify.js";

const FLATTENED = "was flattened into text";

// A positioned glyph run as pdf.js hands one over.
function run(str, x, y, { h = 10, w = null } = {}) {
  return {
    str,
    width: w ?? str.length * 5,
    height: h,
    transform: [h, 0, 0, h, x, y],
  };
}

function markdownOf(items) {
  return linesToMarkdown(reconstructPage(items).lines);
}

// Scattered short fragments at unrelated x — a chart's labels flattened into
// text. Low convergence, and made of fragments.
function labelSoup() {
  const items = [];
  const xs = [40, 133, 291, 76, 400, 212, 355, 91, 268, 460, 180, 320];
  for (let i = 0; i < 30; i++) {
    const x = xs[i % xs.length] + (i % 5) * 13;
    items.push(run(`${(i * 7) % 100}.${i % 10}%`, x, 500 - i * 14));
  }
  return items;
}

// The same scatter, but every fragment is a sentence — a designed layout whose
// blocks legitimately start at many different x.
function proseBlocks() {
  const items = [];
  const xs = [40, 133, 291, 76, 400, 212, 355, 91, 268, 460, 180, 320];
  for (let i = 0; i < 30; i++) {
    const x = xs[i % xs.length] + (i % 5) * 13;
    items.push(
      run(
        `a line of ordinary running prose number ${i} set in this block`,
        x,
        500 - i * 14
      )
    );
  }
  return items;
}

test("a page of scattered fragments still raises the flattened-figure marker", () => {
  assert.match(markdownOf(labelSoup()), new RegExp(FLATTENED));
});

test("a page of prose blocks at the same scatter does not", () => {
  const md = markdownOf(proseBlocks());
  assert.doesNotMatch(
    md,
    new RegExp(FLATTENED),
    "a layout's blocks have no reason to share a left edge; that is not a flattened figure"
  );
});

test("the two differ only in what the page is made of, not in how it lines up", () => {
  // Guards the test above against becoming vacuous: if the prose fixture ever
  // stopped scoring below the threshold, it would pass for the wrong reason.
  // Both fixtures put their runs at the same x positions, so both score low;
  // only the fragment test separates them.
  const soup = labelSoup();
  const prose = proseBlocks();
  assert.deepEqual(
    soup.map((r) => r.transform[4]),
    prose.map((r) => r.transform[4]),
    "fixtures must share their x positions for the comparison to mean anything"
  );
});
