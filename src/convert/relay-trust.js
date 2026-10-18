// Which stored routing rule may the background relay act on? (M9, B1, S6)
//
// The background worker holds the extension's host permissions, so it must not
// POST a document anywhere merely because a content-script message named the
// URL. It resolves the message's rule against the STORED, already-normalized
// routing config and, when a stored rule points at that endpoint, uses the
// stored rule wholesale — endpoint, output, responseField and request encoding
// — never the message's copy.
//
// Three call paths reach the relay, and all three must resolve here:
//   - an `http` / `companion` rule converting a file directly;
//   - an `inbrowser` rule's onEmpty escalation (a scan the browser came up
//     empty on is retried against the rule's endpoint);
//   - the ambiguous prompt's "convert with companion" choice, which relays
//     through whichever matched rule carries an endpoint (companionAvailable).
// The last two send an `inbrowser` rule, so trust is keyed on "an enabled rule
// that carries a valid endpoint", not on the action.
//
// Pure (no chrome.*) so it unit-tests in Node (test/relay-trust.test.mjs).

import { isHttpEndpoint } from "../config/defaults.js";

const sameList = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((x, i) => x === b[i]);

// The stored rule the relay should use for a message's rule, or null when the
// message names no endpoint the stored config points at. When several stored
// rules share the endpoint, the one whose match list is identical to the
// message's wins (it is the rule routeFile picked); otherwise the first.
export function relayRuleFor(routing, msgRule) {
  const endpoint = msgRule?.endpoint;
  if (!isHttpEndpoint(endpoint)) return null;
  const candidates = (routing?.rules ?? []).filter(
    (r) => r && r.enabled !== false && isHttpEndpoint(r.endpoint) && r.endpoint === endpoint
  );
  if (!candidates.length) return null;
  const m = msgRule.match;
  return (
    candidates.find(
      (r) => m && sameList(r.match?.mime, m.mime) && sameList(r.match?.ext, m.ext)
    ) ?? candidates[0]
  );
}
