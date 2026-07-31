// Unit tests for rotated text (ADR 0028): a run whose baseline is not the x
// axis, and the vertical RAIL labels a table uses to head blocks of rows.
// Synthetic glyph items, no PDFs — table-heavy p32 drove the calibration, where
// the emissions table is railed with "Scope 1 and 2" and "Out of scopes" set
// bottom-to-top beside the rows they cover.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructLines, linesToMarkdown } from "../src/convert/classify.js";

function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

// Painted bottom-to-top: the advance runs up the page and the type's own
// height extends to the LEFT of x, so the run occupies a narrow strip.
function rotated(str, x, y, { w = str.length * 5, h = 8 } = {}) {
  return { str, width: w, height: h, transform: [0, h, -h, 0, x, y] };
}

// A three-column table at a known geometry, railed from the left.
function railedTable(rails) {
  const items = [
    item("Item", 60, 400, { h: 8 }),
    item("2024", 275, 400, { h: 8, w: 20 }),
    item("2023", 355, 400, { h: 8, w: 20 }),
  ];
  [
    ["Alpha", "1100", "1200"],
    ["Bravo", "2100", "2200"],
    ["Charlie", "3100", "3200"],
    ["Delta", "4100", "4200"],
  ].forEach(([label, a, b], r) => {
    const y = 380 - r * 14;
    items.push(item(label, 60, y, { h: 8 }));
    items.push(item(a, 280, y, { h: 8, w: 20 }));
    items.push(item(b, 360, y, { h: 8, w: 20 }));
  });
  items.push(...rails);
  return items;
}

test("a rotated rail is not welded into the row it crosses", () => {
  // Read as horizontal, a 40pt-long label becomes 40pt of text sitting ON one
  // baseline, so it spells itself into whatever is printed there.
  const md = linesToMarkdown(
    reconstructLines(railedTable([rotated("GROUP ONE", 30, 338, { w: 28 })]))
  );
  assert.doesNotMatch(
    md,
    /GROUP ONE\w|\w GROUP ONEAlpha|BravoGROUP/,
    `rail spelled into a neighbouring cell:\n${md}`
  );
  assert.match(md, /\| Alpha \| 1100 \| 1200 \|/, `table lost:\n${md}`);
  assert.match(md, /GROUP ONE/, `rail dropped:\n${md}`);
});

test("a rail states its label at the head of the block it covers", () => {
  // The label's baseline sits at the BOTTOM of its span (it reads upward), so
  // writing it into the row its baseline falls in puts a block's heading on the
  // block's last row — where it reads as that row's own label, and as nested
  // under whatever rail is printed above.
  const md = linesToMarkdown(
    reconstructLines(railedTable([rotated("GROUP ONE", 30, 338, { w: 28 })]))
  );
  const rows = md.split("\n").filter((l) => l.startsWith("| "));
  const alpha = rows.find((l) => l.includes("Alpha"));
  const bravo = rows.find((l) => l.includes("Bravo"));
  const delta = rows.find((l) => l.includes("Delta"));
  assert.ok(alpha && bravo && delta, `table rows missing:\n${md}`);
  // The rail spans Bravo..Delta, so Bravo heads it — not Delta, whose baseline
  // the label actually sits on, and not Alpha, which it never covers.
  assert.match(bravo, /GROUP ONE/, `rail not at the head of its block:\n${md}`);
  assert.doesNotMatch(alpha, /GROUP ONE/, `rail reached above its block:\n${md}`);
  assert.doesNotMatch(delta, /GROUP ONE/, `rail restated below its head:\n${md}`);
});

test("two rails side by side are two lines of one label, not one word", () => {
  // A rail that runs to two lines sets the second alongside the first. Along
  // the page's x they abut, so the word-gap test reads them as mid-word.
  const md = linesToMarkdown(
    reconstructLines(
      railedTable([
        rotated("Out of", 30, 338, { w: 28 }),
        rotated("scopes", 39, 338, { w: 28 }),
      ])
    )
  );
  assert.match(md, /Out of scopes/, `rail lines spelled together:\n${md}`);
  assert.doesNotMatch(md, /Out ofscopes/, md);
});

test("a blank form's placeholders are figures, so its rows stay apart", () => {
  // A specimen financial statement writes every value as a placeholder shaped
  // like the number it stands for. To "figures don't wrap" those have to count
  // as figures, or a densely set statement merges: eight line items and their
  // sixteen values arriving in one row, two cells.
  const items = [
    item("Item", 60, 400, { h: 8 }),
    item("2024", 275, 400, { h: 8, w: 20 }),
    item("2023", 355, 400, { h: 8, w: 20 }),
  ];
  const rows = [
    ["CURRENT", "Cash – operations", "xx", "xx"],
    [null, "Tenant accounts receivable", "xx", "xx"],
    [null, "Prepaid expenses", "xx", "xx"],
    ["RESERVES", "Operating Reserve", "(xx,xxx)", "(xx,xxx)"],
    [null, "Lease-up reserve", "xxx", "xxx"],
    [null, "Tax and Insurance escrow", "xx", "xx"],
    ["FIXED", "Buildings & Improvements", "$X,XXX,XXX", "$X,XXX,XXX"],
  ];
  rows.forEach(([group, label, a, b], r) => {
    const y = 386 - r * 11;
    if (group) items.push(item(group, 8, y, { h: 8 }));
    items.push(item(label, 60, y, { h: 8 }));
    items.push(item(a, 280, y, { h: 8, w: 20 }));
    items.push(item(b, 360, y, { h: 8, w: 20 }));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(md, /\| Cash – operations \| xx \| xx \|/, `rows merged:\n${md}`);
  assert.match(md, /\| Lease-up reserve \| xxx \| xxx \|/, md);
  assert.doesNotMatch(
    md,
    /Cash – operations Tenant accounts receivable/,
    `line items collapsed into one cell:\n${md}`
  );
});
