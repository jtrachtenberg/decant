// Route an intercepted file through the routing table (SPEC §3.2–3.4).
//
// Pure and chrome-free — same sharing story as classify.js: unit tests
// (test/route.test.mjs) and any surface can import it. Callers hand it the
// already-normalized routing section of the config (see defaults.js); this
// module does matching only, no validation.
//
// routeFile(file, routing) → { action, rule }
//   `file` needs only { name, type } (a real File works).
//   `rule` is the matched routing rule, or null when nothing matched and the
//   default applied. Rules are ordered; the first enabled rule whose match
//   names the file's MIME type or extension wins.

// MIME types browsers report for more than one format. Windows labels every
// .csv "application/vnd.ms-excel" (the registered handler is Excel), so a MIME
// match alone would send CSVs down the XLS rule and rewrite them as Markdown
// tables (B16, July L8). For these types the extension must agree whenever
// the rule names extensions and the file has one.
const AMBIGUOUS_MIME = new Set(["application/vnd.ms-excel"]);

export function routeFile(file, routing) {
  const mime = (file?.type || "").toLowerCase();
  const ext = extensionOf(file?.name);

  for (const rule of routing?.rules ?? []) {
    if (!rule.enabled) continue;
    const m = rule.match;
    const mimeHit =
      mime &&
      m.mime.includes(mime) &&
      !(AMBIGUOUS_MIME.has(mime) && ext && m.ext.length && !m.ext.includes(ext));
    if (mimeHit || (ext && m.ext.includes(ext))) {
      return { action: rule.action, rule };
    }
  }
  // Unmatched files always pass through — routing.default is pinned to
  // "passthrough" by normalizeConfig, so don't trust an arbitrary value here.
  return { action: "passthrough", rule: null };
}

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// Would any of these files be routed to something other than passthrough?
// The interception handlers ask this synchronously before hijacking an event:
// a batch that converts nothing is left to the page's own handler (B9), and
// only a batch that would really be intercepted consumes the one-shot
// passthrough hotkey (B18).
export function anyWouldConvert(files, routing) {
  return Array.from(files ?? []).some((f) => routeFile(f, routing).action !== "passthrough");
}
