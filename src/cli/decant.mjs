#!/usr/bin/env node
// Decant CLI surface (CLI.md) — headless conversion over the shared core.
//
//   decant convert <input> [--mode <mode>] [--out <file>|--out-dir <dir>]
//                          [--config <file>] [--json] [--quiet|--verbose]
//
// Modes (CLI.md §4) — the classifier verdict, or an override that forces a
// specific variant so decantCC can generate each in its own pass:
//   auto      run the classifier, do what the browser would (default)
//   markdown  force text-only Markdown, whatever the verdict (figures dropped)
//   figures   force convert + extract the document's figures as sibling files
//             (requires --out-dir); the Markdown gains an association note
//   companion high-fidelity via the localhost companion — deferred (later)
//
// stdout carries ONLY the payload (Markdown, or the JSON envelope) so it pipes
// cleanly; all diagnostics go to stderr. Passthrough is intentionally not a mode
// — on the CLI "send the original" just means don't run decant on the file.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { installNodeAssets } from "./node-assets.js";

// Bumped so a packaged binary re-unpacks its embedded assets after an upgrade.
const ASSET_VERSION = "0.1.2";

const EXIT = {
  converted: 0,
  usage: 1,
  error: 2,
  passthrough: 10,
  ambiguous: 11,
};

const MODES = new Set(["auto", "markdown", "figures", "companion"]);

// Minimal MIME hints so a routed file carries a type as well as a name. The
// router and engines dispatch on the extension too, so this is belt-and-braces —
// it just keeps meta.type honest.
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  html: "text/html",
  htm: "text/html",
};

const HELP = `decant — convert documents to Markdown (headless)

Usage:
  decant convert <input> [options]

Options:
  --mode <mode>     auto (default) | markdown | figures | companion
  --out <file>      write Markdown to <file> instead of stdout
  --out-dir <dir>   write output into <dir> (required for --mode figures:
                    the Markdown plus one file per extracted figure)
  --config <file>   routing/profile config JSON (options-page export shape)
  --json            emit a JSON envelope {action,reason,markdown,figures,savings,meta}
  --quiet           suppress the stderr status line
  --verbose         extra stderr diagnostics
  -h, --help        show this help

Exit codes:
  0  converted (Markdown produced)
  10 passthrough / no usable conversion (auto: original is the answer;
     markdown/figures: nothing to extract)
  11 ambiguous (auto only — the classifier wants a forced --mode)
  1  usage error
  2  conversion error
`;

function fail(code, msg) {
  if (msg) process.stderr.write(`decant: ${msg}\n`);
  process.exit(code);
}

// Tiny flag parser: a single `convert` subcommand, one positional input, and
// the long options above. Keeps a dependency-free binary (CLI.md §7).
function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, ...rest] = argv;
  if (command !== "convert") {
    fail(EXIT.usage, `unknown command '${command}' (expected 'convert')`);
  }
  const opts = { mode: "auto", json: false, quiet: false, verbose: false };
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case "--mode": opts.mode = rest[++i]; break;
      case "--out": opts.out = rest[++i]; break;
      case "--out-dir": opts.outDir = rest[++i]; break;
      case "--config": opts.config = rest[++i]; break;
      case "--json": opts.json = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--verbose": opts.verbose = true; break;
      default:
        if (a.startsWith("-")) fail(EXIT.usage, `unknown option '${a}'`);
        positionals.push(a);
    }
  }
  if (positionals.length === 0) fail(EXIT.usage, "missing <input> file");
  if (positionals.length > 1) {
    fail(EXIT.usage, `expected one input, got ${positionals.length} (batch is a v2 nicety)`);
  }
  opts.input = positionals[0];
  if (!MODES.has(opts.mode)) {
    fail(EXIT.usage, `unknown --mode '${opts.mode}' (auto|markdown|figures|companion)`);
  }
  if (opts.mode === "companion") {
    fail(EXIT.usage, "--mode companion is not implemented yet; use auto, markdown, or figures");
  }
  if (opts.mode === "figures" && !opts.outDir) {
    fail(EXIT.usage, "--mode figures requires --out-dir (it emits the Markdown plus figure files)");
  }
  return opts;
}

async function loadRouting(configPath) {
  const { DEFAULT_CONFIG } = await import("../config/defaults.js");
  if (!configPath) return DEFAULT_CONFIG.routing;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    fail(EXIT.usage, `cannot read --config ${configPath}: ${err.message}`);
  }
  // Fail toward global routing (ARCHITECTURE.md §2.1): a config without a usable
  // routing section falls back rather than bricking conversion.
  return parsed?.routing ?? DEFAULT_CONFIG.routing;
}

function readInput(path) {
  const name = basename(path);
  const ext = extname(name).slice(1).toLowerCase();
  return readFile(path)
    .then((buf) => new File([buf], name, { type: MIME[ext] ?? "application/octet-stream" }))
    .catch((err) => fail(EXIT.error, `cannot read ${path}: ${err.message}`));
}

// --- Mode handlers: each returns a common result shape --------------------
// { action, reason, markdown, figureFiles, attachedFigurePages, meta, savings }

async function runAuto(file, routing, core) {
  const res = await core.convertFile(file, routing);
  const markdown =
    res.action === "converted"
      ? await res.file.text()
      : res.action === "ambiguous" && res.converted
        ? await res.converted.text()
        : null;
  return {
    action: res.action,
    reason: res.reason,
    // On ambiguous the safe default is the original, so the text rides in
    // `converted`, not the top-level `markdown`.
    markdown: res.action === "converted" ? markdown : null,
    converted: res.action === "ambiguous" ? markdown : undefined,
    figureFiles: [],
    attachedFigurePages: 0,
    meta: res.meta ?? null,
    savings: res.action === "converted" ? core.estimateSavings(res) : null,
  };
}

// Force text-only conversion regardless of the classifier verdict. The engine
// builds Markdown whenever any text exists (convert or ambiguous); a genuine
// no-text scan yields none and is reported as passthrough.
async function runMarkdown(file, core) {
  const res = await analyze(file, core);
  if (res.markdown == null) {
    return { action: "passthrough", reason: res.reason, markdown: null, figureFiles: [], attachedFigurePages: 0, meta: res.summary };
  }
  return {
    action: "converted",
    reason: res.reason,
    markdown: res.markdown,
    figureFiles: [],
    attachedFigurePages: 0,
    meta: res.summary,
    savings: core.estimateSavings({ meta: res.summary }),
  };
}

// Force convert + attach figures: the text plus the document's figures as
// sibling files, with an association note appended to the Markdown.
async function runFigures(file, core) {
  const res = await analyze(file, core);
  if (res.markdown == null) {
    return { action: "passthrough", reason: res.reason, markdown: null, figureFiles: [], attachedFigurePages: 0, meta: res.summary };
  }
  // Figure extraction can fail on inputs the text engine still reads — most
  // notably a permission-restricted (encrypted, empty-password) PDF: pdf.js
  // decrypts it for text, but pdf-lib (the mini-PDF builder) refuses encrypted
  // input outright, and can't decrypt it, so a chart PDF built anyway would be
  // silently corrupt. Degrade to text-only exactly as the browser does rather
  // than failing the whole conversion — the text (the main payload) is kept.
  let files = [];
  let note = null;
  let attachedFigurePages = 0;
  try {
    const { assembleFigures } = await import("./figures.js");
    ({ files, note, attachedFigurePages } = await assembleFigures(file, res.summary));
  } catch (err) {
    process.stderr.write(
      `decant: figure extraction failed for ${file.name} (${err.message}) — emitting text only\n`
    );
  }
  const markdown = note
    ? `${res.markdown.trimEnd()}\n\n---\n\n${note}\n`
    : res.markdown;
  return {
    action: "converted",
    reason: res.reason,
    markdown,
    figureFiles: files,
    attachedFigurePages,
    meta: res.summary,
    savings: core.estimateSavings({ meta: res.summary, attachedFigurePages }),
  };
}

// Run the raw engine analysis for a forced mode; a type with no engine can't be
// forced to Markdown, so that's a conversion error, not a silent passthrough.
async function analyze(file, core) {
  const engine = core.engineFor(file);
  if (!engine) fail(EXIT.error, `no engine for ${file.name} — cannot force this mode`);
  try {
    return await engine(file);
  } catch (err) {
    fail(EXIT.error, `conversion failed for ${file.name}: ${err.message}`);
  }
}

// --- Output ----------------------------------------------------------------

async function output(opts, result) {
  const base = basename(opts.input, extname(opts.input));

  if (opts.mode === "figures") {
    await mkdir(opts.outDir, { recursive: true });
    const paths = [];
    if (result.markdown != null) {
      const mdPath = join(opts.outDir, `${base}.md`);
      await writeFile(mdPath, result.markdown);
      paths.push(mdPath);
    }
    for (const f of result.figureFiles) {
      const p = join(opts.outDir, f.name);
      await writeFile(p, Buffer.from(await f.arrayBuffer()));
      paths.push(p);
    }
    if (opts.json) process.stdout.write(envelope(opts, result, paths) + "\n");
    return;
  }

  // auto / markdown: Markdown (or the envelope) to --out or stdout.
  if (opts.json) {
    await emit(opts, envelope(opts, result, opts.out ? [opts.out] : []) + "\n");
  } else if (result.action === "converted" && result.markdown != null) {
    await emit(opts, result.markdown);
  }
}

async function emit(opts, text) {
  if (opts.out) await writeFile(opts.out, text);
  else process.stdout.write(text);
}

function envelope(opts, result, paths) {
  return JSON.stringify(
    {
      action: result.action,
      reason: result.reason,
      mode: opts.mode,
      input: opts.input,
      output: paths.length ? paths : null,
      markdown: result.action === "converted" ? result.markdown : null,
      converted: result.converted,
      figures: result.figureFiles.map((f) => f.name),
      attachedFigurePages: result.attachedFigurePages,
      savings: result.savings ?? null,
      meta: result.meta ?? null,
    },
    null,
    2
  );
}

function status(opts, result) {
  if (opts.quiet) return;
  const figs = result.figureFiles.length ? `, ${result.figureFiles.length} figure(s)` : "";
  let where = "";
  if (opts.mode === "figures") where = ` → ${opts.outDir}/`;
  else if (opts.out) where = ` → ${opts.out}`;
  let line = `${result.action} (${result.reason})${figs}${where}`;
  if (result.action === "ambiguous") line += " — rerun with --mode markdown or --mode figures";
  process.stderr.write(`decant: ${line}\n`);
}

function exitFor(action) {
  if (action === "converted") return EXIT.converted;
  if (action === "passthrough") return EXIT.passthrough;
  if (action === "ambiguous") return EXIT.ambiguous;
  return EXIT.error;
}

// Pick the asset source: the embedded zip inside a SEA binary, else the
// installed pdfjs-dist. node:sea is a builtin, kept external in the bundle.
async function installAssets() {
  let sea = null;
  try {
    sea = await import("node:sea");
  } catch {
    /* node:sea unavailable (older Node) — dev/npm path */
  }
  if (sea?.isSea?.()) {
    const { installSeaAssets } = await import("./sea-assets.js");
    await installSeaAssets(sea, ASSET_VERSION);
  } else {
    installNodeAssets();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Resolve pdf.js assets before importing the core: inbrowser.js reads its
  // asset URLs at module load (CLI.md §3.1). A packaged binary (SEA) unpacks its
  // embedded assets; a dev/npm run resolves them from node_modules.
  await installAssets();
  const [index, savings] = await Promise.all([
    import("../convert/index.js"),
    import("../convert/savings.js"),
  ]);
  const core = {
    convertFile: index.convertFile,
    engineFor: index.engineFor,
    estimateSavings: savings.estimateSavings,
  };

  const file = await readInput(opts.input);

  let result;
  if (opts.mode === "auto") {
    const routing = await loadRouting(opts.config);
    result = await runAuto(file, routing, core);
  } else if (opts.mode === "markdown") {
    result = await runMarkdown(file, core);
  } else {
    result = await runFigures(file, core);
  }

  await output(opts, result);
  status(opts, result);
  process.exit(exitFor(result.action));
}

main().catch((err) => fail(EXIT.error, err?.stack || String(err)));
