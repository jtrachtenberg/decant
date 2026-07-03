# Fidelity QA — checking a conversion for information loss

Decant converts to Markdown to save tokens. The risk is **silent loss** —
the Markdown looks fine but dropped data that was in the original. This is a
lightweight way for a tester to catch that: use an LLM as a **fidelity judge**,
feeding it the original and Decant's Markdown and asking, in a structured
way, what (if anything) was lost. The output doubles as a bug report we can
triage.

---

## When to run it

**Only for files Decant *converted*.** Check the page console after attaching a
file:

- `converted …` → there is a Markdown version to audit. **Run this.**
- `passthrough …` (scan / no text / ambiguous) → the original file was sent
  unchanged, so there is nothing to compare. Skip.

---

## Setup (read before you start)

- **Disable Decant for the comparison.** The judge must see the *true* original
  PDF. If Decant is active on the page where you upload it, that PDF gets
  converted too, and you'd be comparing two converted versions. Toggle the
  extension off at `chrome://extensions`, or run the comparison in a chat / on a
  site where Decant isn't active.
- **Privacy first.** These are your own documents. The report below is plain
  text, so you can either use a version that removes PII or share the findings *without* sending us the file. **Do not
  submit confidential PDFs.** If the document is sensitive, send only the report
  and a redacted description.
- **The judge isn't infallible.** It reads the PDF via its own rendering and can
  miss things or over-flag. Treat its report as a strong signal, not proof; for
  important documents, run it twice.

---

## Steps (for testers)

1. Convert a file with Decant as normal. **Download the converted
   `.md` attachment**, and copy the `[decant] converted …` line from the console.
2. **Disable Decant** using the passthrough hotkey (alt-shift-O by default)
3. Paste the **prompt** below and send.
4. Copy the result, paste the `[decant]` console line above it, and send it to us
   as a bug report (omit the PDF if it's sensitive).

---

## The prompt

```
You are auditing a tool that converts PDFs to Markdown to save tokens. I will give you:
1. The ORIGINAL file.
2. The MARKDOWN the tool produced from it.

Determine whether any MEANINGFUL information was lost in the conversion. Compare
them carefully, page by page.

Classify each problem you find:

CATEGORY (one of):
- TEXT      words/sentences/paragraphs missing or garbled
- HEADING   section structure lost or mislabeled
- TABLE     tabular data missing, or present but mis-structured (wrong rows/cols)
- COLUMNS   multi-column text merged/interleaved out of reading order
- FIGURE    data that exists only in an image/chart is missing or unusable
- NUMBERS   figures, statistics, or values dropped or altered
- ORDER     content present but in the wrong order

SEVERITY (one of):
- CRITICAL  changes/loses meaning; a reader would draw wrong conclusions
- MAJOR     notable information lost but the gist survives
- MINOR     cosmetic only (formatting/decorative)

Rules:
- Only report REAL losses you can verify against the file. Do not invent issues.
- Ignore acceptable losses: running headers/footers, page numbers, logos, purely
  decorative elements.
- Quote the specific lost content and cite the page where you can.
- If the Markdown faithfully captures the content, say so plainly.
- Flag your own uncertainty where the file is hard to read.

Respond in EXACTLY this format:

VERDICT: <FAITHFUL | MINOR LOSS | MAJOR LOSS | CRITICAL LOSS>
SUMMARY: <2-3 sentences>

ISSUES:
- [SEVERITY] [CATEGORY] (page N): <description with quoted/located evidence>
(if none: "No information loss found.")

OVERALL FIDELITY: <0-100>% — <one-line justification>
```

---

## What a bug report should include

Paste these together:

1. **Decant's console line** — e.g. `[decant] converted report.pdf → report.md (4p, 1224 chars)`. Tells us the decision, page count, and size.
2. **The judge's report** — the `VERDICT … OVERALL FIDELITY` block above.
3. **Environment** — browser + OS, and the Decant version (`manifest.json`).
4. **The File** *only if it isn't sensitive*; otherwise a short description of its
   layout (single/multi-column, tables, charts, scanned pages).

---

## For maintainers — triaging reports

The judge's issue lines are `[SEVERITY] [CATEGORY] (page N)`, so reports bucket
cleanly by failure mode:

| CATEGORY | Likely cause / next step |
|---|---|
| `COLUMNS` | Multi-column reading-order interleaving — a known limitation; reflow is future work. |
| `TABLE` | Table detection missed a grid or mis-structured one. Reproduce with `npm run inspect`; check column gaps. |
| `FIGURE` / `NUMBERS` (on a **converted** doc) | The classifier should likely have flagged **ambiguous**. Check `chartPages` — raster charts should trip image detection; vector charts won't. Candidate for threshold tuning. |
| `TEXT` / `HEADING` | Extraction or structuring bug in `reconstructLines` / `linesToMarkdown`. |
| `ORDER` | Reading-order / sort issue. |

Cross-check against the decision: a **CRITICAL FIGURE** loss from a `convert`
decision means the classifier under-detected charts — the single most important
class of bug to catch, since it's the silent-degradation case the classifier
exists to prevent. Reproduce locally with:

```
npm run inspect -- "path/to/file"
```

to see the per-page text/image signals behind the decision.
