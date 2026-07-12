# Decant — full code review (2026-07)

Scope: the entire extension source under `src/`, plus `manifest.json` and
`build.mjs`. Baseline: all 251 tests pass (`npm test`). This review was done by
reading every module and tracing data flow; each finding was verified against
the code, and the highest-severity ones were reproduced or demonstrated.

The codebase is careful and well-documented — the security posture in
particular is strong (see "What's solid" at the end). The findings below are
ordered by severity. Items marked **[fixed]** were addressed in the accompanying
commit; the rest are recommendations, mostly in the delicate PDF-reconstruction
engine where a fix needs fixture validation before it's safe to land.

---

## High severity

### H1. Empty activation whitelist silently re-enables all default hosts **[fixed]**
`src/config/defaults.js:170-176`

`normalizeConfig` replaces a zero-length `activation.rules` with the built-in
default rules — all four of which (`claude.ai`, `chatgpt.com`,
`gemini.google.com`, `www.perplexity.ai`) ship `enabled: true`. Because those
hosts are install-granted `host_permissions`, `syncRegistration` in
`background.js` immediately re-registers the content script on them.

Effect: a user who removes **every** host in the options page (leaving
`rules: []`) — or imports a config with `"activation": {"rules": []}` — has
Decant turn itself back on everywhere on the next commit. This directly
violates the default-deny promise in SPEC §3.1 and ADR-0003. The tell is the
asymmetry with `normalizeRouting` (defaults.js:196-198), which correctly
preserves an explicitly-empty `rules: []`. Fixed by mirroring that behaviour:
an absent `activation` falls back to defaults, an explicitly-empty list stays
empty.

### H2. Hostile/corrupt chart part triggers multi-GB allocation (tab-crash DoS) **[fixed]**
`src/convert/chart.js:75`

`cachePoints` sizes a dense array straight from an attacker-controlled XML
attribute: `Array(Math.max(...idx) + 1).fill("")`, where `idx` is the `idx="N"`
of a `<c:pt>`. A single `<c:pt idx="99999999">` in any chart part of a DOCX /
XLSX / PPTX forces a multi-GB allocation — reproduced in Node as a heap-limit
OOM after ~130 s of GC. This runs automatically during analysis (no user
prompt), and it's the one failure mode the "never lose the upload" invariant
can't survive: the passthrough catch in `index.js` never runs because the
process dies. Fixed by bounding the dense array to a sane cap and dropping
out-of-range points; also hardened the `max` computation against a
million-element spread.

### H3. `unescapePunctuation` is O(n²) — multi-minute main-thread freeze on large DOCX **[fixed]**
`src/convert/docx.js:71-78`

The `String.prototype.replace` callback runs `s.slice(0, offset)` (a full-prefix
copy) plus an end-anchored regex for every `.`/`-` escape, and mammoth escapes
every period in the document. Measured on realistic mammoth output: 1 MB of
markdown → ~21 s, 2 MB → ~86 s of **synchronous** content-script work — a
thesis-sized DOCX freezes the chat tab indefinitely mid-upload. Fixed by
replacing the per-match prefix copy with a bounded backward scan to the line
start (behaviour-identical, verified by `test/docx.test.mjs` plus a new
large-input timing guard).

### H4. A second ambiguous prompt strands the first upload and leaks a keydown listener
`src/content/ui.js:28` **[fixed]**

`promptConvertChoice` opens with `document.getElementById(HOST_ID)?.remove()`,
which destroys an in-flight prompt's DOM **without resolving its promise**. If
batch A is awaiting its prompt and the user drops a second ambiguous file, batch
B's prompt supersedes A's host, so: (a) A's `resolveAndInject` awaits forever —
files silently lost; (b) A's capture-phase `keydown` listener stays on
`document`; (c) a later Escape press — minutes on, e.g. closing an unrelated
dialog — fires A's stale `finish("original")` and injects batch A into the
composer at a completely unexpected moment. Fixed by resolving a superseded
prompt as a dismissal (`"original"`) and detaching its listener before the new
one opens.

### H5. Grid band-split silently deleted glyphs in a dead zone above a detected table **[fixed]**
`src/convert/classify.js:301-315`

When a grid (table) was detected, the "above"/"below" prose bands were rebuilt
by recursion, filtered with `g.transform[5] > yTop + 1` and `< yBot - 1`, where
`yTop = max(row.y1)` is the grid's top row baseline **plus a full glyph height**
(`toBox` sets `y1 = baseline + height`, classify.js:1435). Any non-grid line
whose baseline fell in `(gridTopBaseline, yTop + 1]` was excluded from *both*
bands and from `gridLines`, so it vanished with no marker — e.g. an 8 pt caption
10 pt above a 12 pt table header (`10 ≤ 12 + 1` → dropped). Fixed by excluding
the grid's own glyphs by identity (a Set) and splitting the rest at the grid's
baseline span rather than its glyph edges. `detectGrid` takes the longest
consecutive run of aligned rows, so no non-grid line's baseline sits between the
grid's top and bottom baselines — every remaining glyph is cleanly above or
below, and the Set keeps the recursion strictly smaller so it still terminates.

### H6. Tag-rail "single winning band" exclusion — re-examined, **not a bug** (intentional per ADR-0014)
`src/convert/classify.js:487-505`

This was flagged as a silent-drop: `railTable` builds rows from `rest` (non-chip
boxes) plus `best` (the one tightest chip cluster), and `rest` excludes **all**
chip-like `[A-Za-z]{1,2}` boxes, so a hypothetical second rail column ("G RM"
side by side) would land in neither. On investigation this is **by design**, and
overriding it regresses the format. ADR-0014's "Decision" section documents the
exclusion as a hard-learned guard: *"the rail-table's 'text side' must exclude
ALL chip-like boxes, not just the winning band — a region holding nothing but an
R-rail beside an S-rail … must not emit as a `| R | S |` table, because
`sawTable` bypasses [the symbol-rail split] veto and locks the bad split in."*
Real rails carry **one** 1–2-letter chip per item (G/RM/S/MT are *alternatives*,
per the ADR's own description), not two side-by-side; the `| R | S |` case the
finding imagined is exactly what the guard exists to reject. A prototype fix
(admit all chip bands left of the text column) was written, tested, and
**reverted** when it proved to contradict the ADR. One genuine but *low*-severity
residue remains: a standalone 1–2-letter token that pdf.js emits as its own item
*inside* the item text (e.g. "UK") is excluded from `rest` and dropped. It's rare
and narrow; any future fix must rescue only tokens inside the text column without
re-widening rail membership (which would trip the ADR-0014 guard).

---

## Medium severity

### M1. Endpoint fetch has no timeout — a hung endpoint blocks the upload indefinitely
`src/convert/http.js:20-26`

`httpConvert` awaits `fetch(endpoint, …)` with no `AbortController`/timeout, and
the content script awaits it inline. An endpoint that accepts the connection but
never responds leaves the upload stuck behind a "converting" badge until
Chrome's network stack or MV3 worker termination gives up (minutes). The
"dead endpoint never loses an upload" guarantee only holds for endpoints that
*fail fast*; the `onError` fallback never fires because the promise never
settles. Fix: wrap in an `AbortController` with a bounded timeout and treat the
abort as an engine error so the existing fallback runs.

### M2. Chart recovery is not error-isolated — one bad zip entry discards a good conversion
`src/convert/docx.js:162`, `src/convert/xlsx.js:106`, `src/convert/pptx.js:156`

`chartTablesFromZip` / `parseChartXml` run without a try/catch, so a single
chart part with a corrupt deflate stream (`zip.file(p).async(...)` rejects)
throws out of the engine and the whole otherwise-perfect mammoth/SheetJS
conversion falls to passthrough. The upload survives, but a good conversion is
needlessly thrown away for a broken *auxiliary* feature. Fix: wrap chart
recovery per-document (or per-part) and treat failure as "no charts recovered".

### M3. `decodeEntities` throws `RangeError` on out-of-range numeric entities
`src/convert/chart.js:12-18`

`String.fromCodePoint(code)` throws for any numeric entity above `0x10FFFF`
(and for lone surrogates). `decodeEntities` runs on every PPTX text run
(pptx.js:38), so one malformed `&#x110000;` anywhere in a deck kills the whole
conversion to passthrough. Fix: guard the code point (or try/catch per entity)
and fall back to the raw match.

### M4. HTML converter ignores declared charset — legacy encodings become mojibake
`src/convert/html.js:76` + `src/convert/read-file.js:30-36`

`analyzeHtml` reads the file with `blob.text()`, which always decodes UTF-8 and
ignores `<meta charset>`. A windows-1252 file (every "Save as Web Page" Word
export) or Shift_JIS/GBK page decodes to replacement characters, `htmlAnalysis`
still returns `decision: "convert"`, and corrupted Markdown silently replaces
the upload. Fix: sniff the BOM / `<meta charset>` and decode with a matching
`TextDecoder`, or fall back to passthrough when the decode produces a high
U+FFFD ratio.

### M5. pdf.js loading tasks leak a worker on load failure
`src/convert/inbrowser.js:75-76`, `src/convert/pdf-figures.js:83-86, 205-207, 254-256, 368-370`

In all five sites, `await loadingTask.promise` sits *outside* the try/finally
that calls `loadingTask.destroy()`. In bundled pdf.js 6.1.200, `getDocument`
eagerly creates a `PDFWorker`, and on load failure (password-protected/corrupt
PDF) nothing tears it down without an explicit `destroy()`. Repeated attempts
accumulate zombie workers plus the transferred file bytes. Fix: `destroy()` the
loading task in a `catch`/`finally` that also covers the `.promise` await.

### M6. Concurrent uploads aren't serialized — the second injection can overwrite the first
`src/content/intercept.js:188, 466-482`

The module carefully makes injection all-or-nothing *within* a batch because a
second `.files` assignment replaces the FileList — but nothing serializes
*across* batches. Pick a slow PDF, then drop a second file before it finishes:
both resolve to `injectViaInput` on the same hidden input, and on a site that
copies `input.files` asynchronously the first batch is lost. Fix: chain
`resolveAndInject` calls through a shared promise so injections are sequential.

### M7. `resolveAndInject` is fire-and-forget with no catch — an unexpected throw loses the upload **[fixed]**
`src/content/intercept.js:504, 582, 629`

All three interception paths call `stopImmediatePropagation()` (and
`preventDefault()`) *before* the async pipeline, then call `resolveAndInject(…)`
with no `.catch()`. `convertFile` is internally hardened, but the surrounding
body (`showConvertingBadge` if `document.body` is briefly null during SPA
teardown, `aggregateSavings`, `dataTransferWith`) can still throw — and any
escape means the user gets neither the original upload nor a failure notice.
Fixed by adding `.catch(() => showAttachFailureNotice(names))` at all three call
sites.

### M8. Paste handler hijacks Office cell copies, dropping the intended text
`src/content/intercept.js:593-632`

The paste handler intercepts whenever `clipboardData.files` is non-empty. Copying
cells from Excel/Word puts text/plain, text/html **and** an image/png file item
on the clipboard, so the paste is cancelled and the image is injected as a
passthrough attachment while the table text the user meant to paste never
reaches the composer. Fix: only intercept when at least one file would actually
be routed to conversion, or when the clipboard carries no text representation.

### M9. Background relay POSTs to an unvalidated endpoint
`src/background.js:89-99`

The relay fetches `msg.rule.endpoint` verbatim with the extension's host
permissions, with no `sender` check and no validation against stored config.
Web pages can't send runtime messages (no `externally_connectable`), so this is
not exploitable today — but it makes content-script integrity the sole boundary
and would become an exfiltration primitive if a port or `onMessageExternal` is
ever added. Defense-in-depth: re-load config in the worker and only honour
endpoints present in the stored, already-validated routing rules; also enforce
`MAX_RELAY_BYTES` here, not only on the sending side.

### M10. Sort comparators don't establish a total order
`src/convert/classify.js:1319-1323, 1820-1824`

`(a,b) => Math.abs(dy) > 2 ? dy : xOrder` is intransitive (A<B, B<C, C<A for
baselines ~1.9 pt apart). With an inconsistent comparator V8's output order is
unspecified, so tiny text / sub-superscript chains / slightly skewed scans can
come out of reading order and split one visual line into several. Fix: sort by a
consistent key — quantise the baseline into line buckets first, then sort by
`(bucket, x)`.

### M11. `emitTable` doesn't escape `|` in cell text
`src/convert/classify.js:2021-2031`

Cells are joined raw with `" | "`. A cell containing a literal pipe (common in
titles/legal text: "Revenue | FY2023") shifts every later cell one column right,
silently mis-mapping values to headers — the exact "confidently wrong table"
failure the corrupt-cell gate exists to prevent. The DOCX/XLSX cell builders
already escape pipes; this path should too. (Note `\n`/`\r` from a broken
ToUnicode map leak into cells the same way — the C0 gate at classify.js:1119
exempts them on the assumption line reconstruction strips them, which
classify.js:1416 does not.)

### M12. `xlsx.js` cell-cap check runs *after* full conversion; `Math.max(...)` can overflow the stack **[fixed]**
`src/convert/xlsx.js:65, 85-120`

Two issues: (1) `Math.max(0, ...grid.map(r => r.length))` spreads one argument
per row and throws `RangeError: Maximum call stack size exceeded` past ~125k
rows — *before* the `MAX_CELLS` guard, so an oversized workbook exits via the
generic error path instead of the intended `"too-large"` passthrough. (2) The
`MAX_CELLS` decision is made only after every sheet has been fully converted to
Markdown, so a 100 MB workbook is parsed and stringified in full just to be
discarded. Fixed the overflow (finding 1) with a reduce; the early-out
(finding 2) is left as a recommendation since it changes control flow.

---

## Low severity / polish

- **L1. New routing rules are appended after enabled defaults and silently
  shadowed** (`options.js:307`, `route.js:18-27`). `routeFile` is
  first-enabled-match and `addRule` always pushes, so a user-added
  "pdf → endpoint" rule never fires while the default PDF-inbrowser rule sits at
  index 0, with no reorder UI and no shadowed-rule warning.
- **L2. Options page never subscribes to `onConfigChanged` and writes the whole
  object** (`options.js:28, 42-59`), so a concurrent write (e.g. the in-page
  "set as default") is clobbered by the next options edit — a lost update.
- **L3. Endpoint URLs are stored in `chrome.storage.sync`** (`config.js:16-17`)
  though SPEC §3.5 says secrets belong in `storage.local`; since rules have no
  auth field, an API key in the query string syncs across machines, and a
  remote-endpoint rule confirmed on one machine becomes active on another with
  no warning shown there.
- **L4. Stale-index mutation in `removeRule`/`toggleRule`** (`options.js:243-247`)
  — a double-click during a slow `storage.sync` write can splice the wrong rule.
- **L5. Endpoint host permissions are requested but never removed**
  (`options.js:328-362`) — deleting/replacing a rule leaves `https://old-host/*`
  granted forever.
- **L6. `importJson` gives no feedback when `normalizeRule` silently drops rules**
  (`options.js:328-362`) — a typo'd endpoint just makes the rule vanish under a
  "Config applied" message.
- **L7. Imported `enabled: true` hosts render as active without a permission
  grant** (`options.js:337, 355`) — the checkbox lies about the running state
  after the status toast fades.
- **L8. Default XLSX rule matches `application/vnd.ms-excel`** (`defaults.js:51,66`),
  which Windows reports for `.csv`/`.tsv`; `routeFile` matches on MIME alone, so
  CSV uploads get silently converted by SheetJS on those machines.
- **L9. `isEvalSupported` not set on `getDocument`** (`inbrowser.js:65-69`) —
  MV3 CSP already blocks eval so pdf.js falls back safely, but setting
  `isEvalSupported: false` makes the intent explicit.
- **L10. Upload/hotkey listeners don't check `event.isTrusted`**
  (`intercept.js:485-632`, `passthrough.js:64-94`) — a whitelisted page can
  synthesize `change`/`drop`/`paste`/hotkey events. Low impact (the page already
  owns the content and can't reach a remote endpoint), but a one-line guard is
  cheap defense-in-depth.
- **L11. Output filename collisions** (`result.js:10`, `http.js:81`) — `a.pdf`
  and `a.docx` both become `a.md` in one batch with no dedup.
- **L12. Image alt/`descr` text flows into `[image omitted: …]` markers and
  table cells unescaped** (`docx.js:53`, `html.js:48`, `pptx.js:59-62`) — a `]`
  defeats the marker-stripping regex; a `|` corrupts a GFM row; a decoded
  newline injects a structural line.
- **L13. `manifest.json` install prompt claim is stale** — the background
  comment / ADR-0003 say "only claude.ai is a required host permission" but the
  manifest now requires four; worth reconciling before store review.
- **L14. Figures flow re-opens the PDF up to 4× sequentially**
  (`pdf-figures.js`, `pdf-subset.js`) — each spawns a fresh worker with a full
  copy of the bytes and re-scans the same chart pages `analyzePdf` already
  scanned; a shared loading task would roughly halve figure-attach wall time.
- **L15. No raw input-size / zip-bomb ceiling on the in-browser path**
  (`inbrowser.js`, the zip engines) — the 32 MB `MAX_RELAY_BYTES` guards only the
  relay; a small zip bomb or very large PDF can exhaust memory when analysis
  auto-runs on attach.

---

## What's solid (audited, no finding)

- **No data exfiltration.** The only non-extension outbound `fetch` is
  `httpConvert`, gated by a user-created rule, a non-localhost `confirm()`
  warning, and a granted host permission. No telemetry, analytics, or beacons —
  the privacy-policy promise holds.
- **No DOM XSS.** Options page and in-page UI assign every attacker-influenced
  value via `textContent`; `innerHTML` carries only static template strings, and
  the panels live in shadow roots.
- **No extension messaging surface for web pages.** No `externally_connectable`,
  no `onMessageExternal`, no `postMessage` bridge; `runtime.onMessage` is
  reachable only from Decant's own contexts.
- **Config import is hardened.** `normalizeConfig`/`normalizeRule` rebuild a
  fresh object graph, drop unknown actions, pin `routing.default` to
  `passthrough`, and reject endpoint-less companion/http rules — no prototype
  pollution, no silent-POST import.
- **No XXE / billion-laughs.** OOXML parsing is regex/pattern-based or via
  SheetJS/mammoth; the hand-rolled entity decoder is non-recursive.
- **The passthrough invariant holds structurally.** Every engine is wrapped so a
  thrown error yields passthrough and the upload is never lost — the only breaks
  are paths that *kill the process* rather than throw (H2, and the freeze in H3),
  both addressed here.
- **MV3 worker sleep/restart mid-conversion degrades safely** to the `onError`
  fallback, and the Firefox/Chromium build divergences in `build.mjs` match the
  documented quirks.
