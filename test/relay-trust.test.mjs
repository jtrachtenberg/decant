// Unit tests for the background relay's trust resolution (src/convert/
// relay-trust.js — B1/S6). The relay must accept every path that legitimately
// reaches it (http/companion rules, onEmpty escalation, the ambiguous prompt's
// "convert with companion") and must use the STORED rule, never the message's.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { relayRuleFor } from "../src/convert/relay-trust.js";
import { normalizeConfig } from "../src/config/defaults.js";
import { routeFile } from "../src/router/route.js";
import { shouldEscalate, companionAvailable } from "../src/convert/result.js";

const EP = "http://127.0.0.1:8765/convert";

const routingWith = (...rules) => normalizeConfig({ version: 5, routing: { rules } }).routing;

test("an http/companion rule's own endpoint is trusted", () => {
  const routing = routingWith({
    match: { ext: ["pdf"] },
    action: "companion",
    endpoint: EP,
    responseField: "markdown",
  });
  const { rule } = routeFile({ name: "a.pdf", type: "" }, routing);
  assert.equal(relayRuleFor(routing, rule), routing.rules[0]);
});

test("onEmpty escalation through an inbrowser rule is trusted (B1)", () => {
  const routing = routingWith({
    match: { mime: ["application/pdf"], ext: ["pdf"] },
    action: "inbrowser",
    onEmpty: "companion",
    endpoint: EP,
    responseField: "markdown",
  });
  const { rule } = routeFile({ name: "scan.pdf", type: "application/pdf" }, routing);
  // The content side decides to escalate with exactly this rule…
  assert.ok(shouldEscalate({ action: "passthrough", reason: "no-text" }, rule));
  // …and the relay must accept it.
  assert.equal(relayRuleFor(routing, rule), routing.rules[0]);
});

test("the ambiguous prompt's companion choice through an inbrowser rule is trusted (B1)", () => {
  const routing = routingWith({
    match: { ext: ["docx"] },
    action: "inbrowser",
    onEmpty: "http",
    endpoint: EP,
  });
  const { rule } = routeFile({ name: "r.docx", type: "" }, routing);
  assert.ok(companionAvailable(rule));
  assert.ok(relayRuleFor(routing, rule));
});

test("an endpoint that no stored rule carries is rejected", () => {
  const routing = routingWith({ match: { ext: ["pdf"] }, action: "companion", endpoint: EP });
  assert.equal(relayRuleFor(routing, { match: { ext: ["pdf"] }, endpoint: "https://evil.example/x" }), null);
  assert.equal(relayRuleFor(routing, { match: { ext: ["pdf"] } }), null);
  assert.equal(relayRuleFor(routing, null), null);
  assert.equal(relayRuleFor(routing, { endpoint: "javascript:alert(1)" }), null);
});

test("a disabled rule's endpoint is not trusted", () => {
  const routing = routingWith({ match: { ext: ["pdf"] }, action: "companion", endpoint: EP, enabled: false });
  assert.equal(relayRuleFor(routing, { match: { mime: [], ext: ["pdf"] }, endpoint: EP }), null);
});

test("the stored rule is used wholesale, not the message's copy (S6)", () => {
  const routing = routingWith({
    match: { ext: ["pdf"] },
    action: "companion",
    endpoint: EP,
    responseField: "markdown",
    output: { ext: "md", mime: "text/markdown" },
  });
  const forged = {
    match: { mime: [], ext: ["pdf"] },
    action: "companion",
    endpoint: EP,
    responseField: "other",
    output: { ext: "html", mime: "text/html" },
    request: { encoding: "base64-json" },
  };
  const got = relayRuleFor(routing, forged);
  assert.equal(got.responseField, "markdown");
  assert.deepEqual(got.output, { ext: "md", mime: "text/markdown" });
  assert.equal(got.request, undefined);
});

test("with two rules on one endpoint, the one routeFile matched wins", () => {
  const routing = routingWith(
    { match: { ext: ["pdf"] }, action: "companion", endpoint: EP, responseField: "pdfField" },
    { match: { ext: ["docx"] }, action: "companion", endpoint: EP, responseField: "docxField" }
  );
  const { rule } = routeFile({ name: "a.docx", type: "" }, routing);
  assert.equal(relayRuleFor(routing, rule).responseField, "docxField");
});
