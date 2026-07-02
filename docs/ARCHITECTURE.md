# Decant — Architecture (core)

> The surface-agnostic heart of Decant. Every surface (see
> [SURFACES.md](./SURFACES.md)) plugs into this core; only the intake layer
> differs.

---

## 1. Why — the token economics

When you upload a PDF to an LLM, you don't just pay for the text. The system
renders **every page as an image** and sends that alongside the extracted text,
so you're billed twice per page. Per Anthropic's own PDF-support docs, text alone
runs ~1,500–3,000 tokens/page, *plus* image tokens because each page is converted
to an image. A 100-page PDF whose actual text is ~30k tokens can land at
70k–100k tokens once image tokens are counted.

The fix is not "stop the model from converting" — it's **strip the expensive
image-rendering layer up front** by handing the model Markdown/text. Reported
savings range from "more than half" to 90%+, concentrated on PDFs (DOCX/PPTX/XLSX
have overhead too, but far less dramatic).

**The non-obvious tradeoff:** the image layer isn't pure waste. It's what lets the
model read charts, scanned pages, complex tables, handwriting. Blind conversion
silently degrades visually-heavy documents. So conversion must be *smart or
optional*, never unconditional. This single constraint drives most of the design.

This is the shared "why" for every surface Decant ships on.

---

## 2. The pipeline

Decant is, abstractly and independent of any surface, a four-step pipeline:

```
intercept → route by type → transform → substitute
```

Only the **intake** steps — `intercept` (capture the file the user is about to
send) and `substitute` (hand the converted result back) — are surface-specific.
The middle of the pipeline — `route by type` and `transform` — is **shared
across every surface**. A browser extension, a desktop MCP server, and a mobile
share target differ only in how they grab the file and return the result; the
routing table and the converter engines behind them are identical.

### 2.1 Configuration layering — profiles

The routing table is global policy, but one destination can need to diverge
from it: convert PDFs to Markdown everywhere *except* site X, or forward a file
type to a specific endpoint only for one host. **Profiles** are that overlay —
the same rule shape as global routing, scoped to a destination (a host for the
browser extension; a server or share target for other surfaces) and merged over
the global table. Routing config resolves most-specific-wins for each
intercepted file:

1. **One-shot manual override** (e.g. the browser passthrough hotkey — §5).
2. **Profile rule** for the file's destination, if one names its type.
3. **Global routing rule** for its type.
4. **Default: passthrough.**

Principles every surface's realization must keep:

- **Per-key merge, not wholesale replacement.** A profile overrides only the
  file-type keys it names; "site X: PDFs passthrough" must not silently drop
  the global DOCX rule on that site.
- **Validate on load, fail toward global.** Config is user-editable; a
  malformed profile is discarded wholesale (falling back to global routing)
  rather than allowed to brick conversion for one destination.
- **The privacy guardrail follows the rule, not the layer.** A non-localhost
  endpoint configured inside a profile warns exactly like a global one — more
  important, even, since a per-site rule is easier to set and forget.

Profiles are also the designated home for per-destination adapter settings as
they accumulate (selector heuristics, accepted-type quirks). The capability is
core; the matcher shape and storage are per-surface — browser realization in
[`SPEC.md`](../SPEC.md) §3.8 (planned, M4).

---

## 3. The converter interface & boundary

The good image-aware converters are **Python** and several need ML models/GPU.
A browser sandbox is **JS** — it cannot run Docling/MarkItDown in-process. So the
converter is defined as a **swappable interface behind an HTTP boundary**, with
three implementations:

| Shape | Quality | Privacy | User setup | Verdict |
|---|---|---|---|---|
| **A. Pure in-browser** (pdf.js + JS converter) | Text-only, weak tables/figures | Full | None | **MVP** |
| **B. Local companion** (intake → `localhost` Python service) | High (Docling/MarkItDown) | Full | Run a helper | **Quality tier** |
| **C. Hosted API** (LlamaParse / Mistral OCR) | Highest | Docs leave machine | API key | Optional, undercuts the "save money" motive |

**Recommendation:** Ship **A** to prove the surface works end-to-end, but design
the conversion call as a swappable interface so **B** drops in as a "high-fidelity"
toggle without touching the intake layer. Treat C as a later opt-in.

```
[intake: intercept] → [converter interface] → [substitute file back in]
                              │
                ┌─────────────┼──────────────┐
             A: in-browser  B: localhost   C: hosted API
```

Because the boundary is HTTP and the interface is engine-agnostic, the same core
serves every surface; intake is the only thing that changes.

---

## 4. Parsing vs. recognition — the core dividing line

The principled line for what runs where is **parsing vs. recognition**:

- **Parsing** — reading data that is *already structured*. Digital PDFs carry a
  real text layer; Office files (DOCX/PPTX/XLSX) are just zipped XML. Parsing is
  **fast, in-browser, and zero-install** (pdf.js, mammoth.js, SheetJS).
- **Recognition** — turning *pixels or ambiguous geometry into structure*: OCR on
  scanned pages, neural table extraction, figure description. Recognition needs
  real models, so it runs in the **optional local companion**.

The majority of real uploads — clean PDFs, Word docs, spreadsheets — fall on the
parsing side and need nothing installed. The companion is a genuine power tier,
not a degraded fallback. (See [ADR-0002](./adr/0002-parsing-vs-recognition-boundary.md).)

---

## 5. Handling the image layer

Two strategies, exposed as a user setting:

1. **Extract-and-reference** — pull real figures out as image files, embed them
   in the Markdown (`![](fig1.png)`). Model sees pixels only for figures that
   matter, not full-page renders. Moderate token cost.
2. **Describe-in-text (figure annotation)** — a vision model writes a textual
   caption per figure, inlined as plain text. Zero downstream image tokens.
   Lossy (you trust the converter's VLM), maximally cheap.

**Smart default:** detect whether a PDF has a real text layer.
- Clean digital PDF → convert freely (extract-and-reference for figures).
- Image-only / scanned / chart-heavy → either run OCR, or **pass through
  unchanged** and let the original images reach the model. Never silently drop
  visual content.

**Manual override is required of every surface.** Because the convert /
passthrough / ambiguous decision is a heuristic, it must always be
user-overridable — never a silent verdict. Two capabilities are mandatory on
*every* surface, however that surface can realize them:

- **Override an ambiguous result** — when a document is classified *ambiguous*
  (substantial text *and* meaningful images/charts, where text-only conversion
  would drop the charts), present a "Convert" vs. "Send original" choice instead
  of guessing.
- **Force passthrough** — let the user pre-declare that a given upload must be
  sent untouched, for when they already know its image layer matters.

The *capability* is core; the *mechanism* is per-surface. The browser extension
realizes these as an in-composer toggle and a configurable passthrough hotkey
(see [`SPEC.md`](../SPEC.md) §3.7); an MCP server would expose them as a tool
parameter; a mobile share target as a toggle in the share sheet. Each surface
doc specifies its own realization.

---

## 6. Converter library landscape (public, mostly open-source)

| Library | Lang | Images | Tables | OCR | License | Notes |
|---|---|---|---|---|---|---|
| **PyMuPDF4LLM** | Py | Extract | Good | Auto | (PyMuPDF) | Fast, light, great MVP for shape B |
| **MarkItDown** (MS) | Py | Describe (LLM Vision) | Good | Optional | MIT | 15+ formats, MCP server, no GPU |
| **Docling** (IBM) | Py | Classify + LLM-annotate | Excellent | Yes | MIT-ish | Best structure; "describe-in-text" out of the box |
| **Marker** | Py | Extract (+`--use_llm`) | Excellent | Yes | GPL/commercial caveat | Swiss-army; check license for any commercial use |
| **MinerU** | Py | Partial | Very good | Yes | Open | CJK/academic specialist |
| **LlamaParse / Mistral OCR** | Hosted | Strong | Strong | Yes | Commercial | Shape C only |
| **pdf.js** (Mozilla) | **JS** | Manual | Weak | No | Apache | The realistic in-browser engine for shape A |

**For B's first cut:** MarkItDown (MIT, no GPU, dead-simple `pip install`) or
PyMuPDF4LLM. **For best fidelity:** Docling. **Mind Marker's license** if this
ever goes commercial.

---

## 7. Dependency & licensing boundary

> Not legal advice — a map of the decision, to be sanity-checked before release.
> The license *choice* is recorded in
> [ADR-0001](./adr/0001-license-polyform-noncommercial.md); what follows is the
> dependency boundary that choice imposes on bundled engines.

- Permissive deps bundle fine — pdf.js (Apache-2.0), mammoth.js (BSD),
  SheetJS community (Apache-2.0). Preserve their notices.
- **Marker is GPL-ish.** You **cannot** add a "no commercial use" restriction on
  top of GPL code you bundle or link — GPL forbids extra restrictions and requires
  the combined work to permit commercial use. Keep Marker **behind the local-server
  process boundary** and call it over HTTP only; arm's-length IPC with a separate
  GPL process is generally aggregation, not a derivative work, so it doesn't reach
  back into the extension.
- **MarkItDown and Docling are MIT** — no such issue. Prefer them as the default
  companion engine; treat Marker as an optional, isolated extra.
