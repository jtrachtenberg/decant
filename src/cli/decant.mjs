#!/usr/bin/env node
// Decant CLI surface (CLI.md) — headless conversion over the shared core.
//
//   decant convert <input> [--mode auto] [--out <file>] [--json]
//                          [--config <file>] [--quiet|--verbose]
//
// This is the C0 milestone: --mode auto (run the classifier, do what the browser
// would), Markdown to stdout, the --json envelope, and the scriptable exit codes
// decantCC branches on. The forced modes (--mode markdown|figures|companion|
// passthrough) are recognized so the surface shape is stable, but only `auto` is
// wired here; the rest report "not yet implemented" until C1.
//
// stdout carries ONLY the payload (Markdown or the JSON envelope) so it pipes
// cleanly; all diagnostics go to stderr.

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { installNodeAssets } from "./node-assets.js";

const EXIT = {
  converted: 0,
  usage: 1,
  error: 2,
  passthrough: 10,
  ambiguous: 11,
};

// C1 will thread these through the core; today only `auto` is live.
const MODES = new Set(["auto", "markdown", "figures", "companion", "passthrough"]);

// Minimal MIME hints so a routed file carries a type as well as a name. The
// router matches on either, and the engines dispatch on the extension too, so
// this is belt-and-suspenders — but it keeps `meta.type` honest in --json.
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
  --mode <mode>     auto (default) | markdown | figures | companion | passthrough
                    Only 'auto' is implemented in this build (C0); the forced
                    modes land in C1.
  --out <file>      write output to <file> instead of stdout
  --config <file>   routing/profile config JSON (options-page export shape)
  --json            emit a JSON envelope {action,reason,markdown,savings,meta}
  --quiet           suppress the stderr status line
  --verbose         extra stderr diagnostics
  -h, --help        show this help

Exit codes:
  0  converted (Markdown produced)
  10 passthrough (no usable conversion; original is the right answer)
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
      case "--mode":
        opts.mode = rest[++i];
        break;
      case "--out":
        opts.out = rest[++i];
        break;
      case "--config":
        opts.config = rest[++i];
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
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
    fail(EXIT.usage, `unknown --mode '${opts.mode}' (auto|markdown|figures|companion|passthrough)`);
  }
  if (opts.mode !== "auto") {
    fail(EXIT.usage, `--mode ${opts.mode} is not implemented in this build yet (C1); use --mode auto`);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Resolve pdf.js assets against the installed pdfjs-dist, THEN import the
  // core: inbrowser.js reads its asset URLs at module load (CLI.md §3.1).
  installNodeAssets();
  const [{ convertFile }, { estimateSavings }] = await Promise.all([
    import("../convert/index.js"),
    import("../convert/savings.js"),
  ]);

  let buf;
  try {
    buf = await readFile(opts.input);
  } catch (err) {
    fail(EXIT.error, `cannot read ${opts.input}: ${err.message}`);
  }
  const name = basename(opts.input);
  const ext = extname(name).slice(1).toLowerCase();
  const file = new File([buf], name, { type: MIME[ext] ?? "application/octet-stream" });

  const routing = await loadRouting(opts.config);

  let res;
  try {
    res = await convertFile(file, routing);
  } catch (err) {
    fail(EXIT.error, `conversion failed for ${name}: ${err.message}`);
  }

  const markdown =
    res.action === "converted"
      ? await res.file.text()
      : res.action === "ambiguous" && res.converted
        ? await res.converted.text()
        : null;

  if (opts.json) {
    const envelope = {
      action: res.action,
      reason: res.reason,
      mode: opts.mode,
      input: opts.input,
      markdown: res.action === "converted" ? markdown : null,
      // On ambiguous the safe default is the original, so the Markdown rides in
      // its own field rather than the top-level `markdown`.
      converted: res.action === "ambiguous" ? markdown : undefined,
      savings: res.action === "converted" ? estimateSavings(res) : null,
      meta: res.meta ?? null,
    };
    await emit(opts, JSON.stringify(envelope, null, 2) + "\n");
  } else if (markdown != null && res.action === "converted") {
    await emit(opts, markdown);
  }

  status(opts, res);
  process.exit(exitFor(res.action));
}

function exitFor(action) {
  if (action === "converted") return EXIT.converted;
  if (action === "passthrough") return EXIT.passthrough;
  if (action === "ambiguous") return EXIT.ambiguous;
  return EXIT.error;
}

async function emit(opts, text) {
  if (opts.out) {
    await writeFile(opts.out, text);
  } else {
    process.stdout.write(text);
  }
}

function status(opts, res) {
  if (opts.quiet) return;
  const where = opts.out ? ` → ${opts.out}` : "";
  let line = `${res.action} (${res.reason})${where}`;
  if (res.action === "ambiguous") {
    line += " — rerun with a forced --mode to pick a variant";
  }
  process.stderr.write(`decant: ${line}\n`);
}

main().catch((err) => fail(EXIT.error, err?.stack || String(err)));
