// Pure mapping from a PDF analysis outcome to the converter's return contract
// (documented in index.js). Deliberately imports nothing — no pdf.js, no
// chrome.* — so the mapping is unit-testable in Node (test/convert.test.mjs);
// index.js can't be imported there because its pdf.js dependency touches
// chrome.runtime at module load.

function markdownFile(original, markdown) {
  const name = original.name.replace(/\.[a-z0-9]+$/i, "") + ".md";
  return new File([markdown], name, { type: "text/markdown" });
}

// `res` is an engine analysis result (analyzePdf / analyzeDocx), or null when
// analysis threw — the caller logs the error and the file passes through
// untouched with reason "error".
export function resultFromAnalysis(file, res) {
  if (!res) {
    return { action: "passthrough", file, reason: "error" };
  }

  if (res.decision === "convert") {
    return {
      action: "converted",
      file: markdownFile(file, res.markdown),
      original: file,
      reason: res.reason,
      meta: res.summary,
    };
  }

  if (res.decision === "ambiguous") {
    // Text plus meaningful charts: converting to text-only would drop the
    // charts, so let the user choose. Default (`file`) is the original.
    return {
      action: "ambiguous",
      file,
      converted: markdownFile(file, res.markdown),
      reason: res.reason,
      meta: res.summary,
    };
  }

  // "passthrough" (no usable text): keep the original untouched.
  return { action: "passthrough", file, reason: res.reason, meta: res.summary };
}

// Forward escalation (SPEC §3.3): decide whether an in-browser passthrough
// should be retried against the rule's companion/http endpoint. Fires only when
// the browser genuinely came up empty — a scan (`no-text`) or a type it has no
// engine for (`no-engine`) — AND the rule opts in with an escalation target and
// a usable endpoint. A browser-only user configures neither, so their scans
// just pass through; a successful or ambiguous conversion is never escalated.
// Pure and exported so the decision is unit-tested without chrome.* or pdf.js.
export const ESCALATE_REASONS = ["no-text", "no-engine"];

export function shouldEscalate(result, rule) {
  return (
    !!result &&
    result.action === "passthrough" &&
    ESCALATE_REASONS.includes(result.reason) &&
    !!rule &&
    (rule.onEmpty === "companion" || rule.onEmpty === "http") &&
    typeof rule.endpoint === "string" &&
    /^https?:\/\//i.test(rule.endpoint)
  );
}

// Is a companion/endpoint configured for a matched rule's type? True when the
// rule carries a usable endpoint (set via the options form's escalation config).
// Drives the ambiguous prompt's "convert with companion" third choice: an
// ambiguous doc (text + charts) can be sent to the companion — which captures
// the visuals the in-browser text-only conversion drops — but only when one is
// actually configured, so browser-only users see just convert/original. Pure
// and exported for direct unit testing.
export function companionAvailable(rule) {
  return (
    !!rule &&
    typeof rule.endpoint === "string" &&
    /^https?:\/\//i.test(rule.endpoint)
  );
}
