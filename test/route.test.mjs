// Unit tests for the routing-table matcher (src/router/route.js). Pure logic;
// routing sections below are written in already-normalized form (the router's
// contract — validation lives in defaults.js / normalizeConfig).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFile } from "../src/router/route.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config/defaults.js";

const rule = (over) => ({
  match: { mime: [], ext: [] },
  action: "inbrowser",
  enabled: true,
  onError: "passthrough",
  ...over,
});

test("default routing sends a PDF to the in-browser engine", () => {
  const file = { name: "report.pdf", type: "application/pdf" };
  const { action, rule: hit } = routeFile(file, DEFAULT_CONFIG.routing);
  assert.equal(action, "inbrowser");
  assert.equal(hit, DEFAULT_CONFIG.routing.rules[0]);
});

test("unmatched files fall through to passthrough with no rule", () => {
  const file = { name: "photo.png", type: "image/png" };
  assert.deepEqual(routeFile(file, DEFAULT_CONFIG.routing), {
    action: "passthrough",
    rule: null,
  });
});

test("extension matches when the MIME type is missing or generic", () => {
  const routing = normalizeConfig(undefined).routing;
  // Browsers sometimes hand over application/octet-stream or an empty type.
  assert.equal(routeFile({ name: "Q3.PDF", type: "" }, routing).action, "inbrowser");
  assert.equal(
    routeFile({ name: "Q3.pdf", type: "application/octet-stream" }, routing).action,
    "inbrowser"
  );
});

test("first enabled match wins; disabled rules are skipped", () => {
  const routing = {
    default: "passthrough",
    rules: [
      rule({ match: { mime: ["application/pdf"], ext: [] }, action: "http", enabled: false }),
      rule({ match: { mime: ["application/pdf"], ext: [] }, action: "inbrowser" }),
      rule({ match: { mime: [], ext: ["pdf"] }, action: "passthrough" }),
    ],
  };
  const { action } = routeFile({ name: "a.pdf", type: "application/pdf" }, routing);
  assert.equal(action, "inbrowser");
});

test("an explicit passthrough rule beats a later convert rule", () => {
  const routing = {
    default: "passthrough",
    rules: [
      rule({ match: { mime: [], ext: ["pdf"] }, action: "passthrough" }),
      rule({ match: { mime: ["application/pdf"], ext: ["pdf"] }, action: "inbrowser" }),
    ],
  };
  assert.equal(
    routeFile({ name: "a.pdf", type: "application/pdf" }, routing).action,
    "passthrough"
  );
});

test("files with no extension and no type never match, and don't throw", () => {
  const routing = normalizeConfig(undefined).routing;
  assert.equal(routeFile({ name: "README", type: "" }, routing).action, "passthrough");
  assert.equal(routeFile({}, routing).action, "passthrough");
  assert.equal(routeFile(null, routing).action, "passthrough");
});

test("empty or missing routing passes everything through", () => {
  const file = { name: "a.pdf", type: "application/pdf" };
  assert.equal(routeFile(file, { default: "passthrough", rules: [] }).action, "passthrough");
  assert.equal(routeFile(file, undefined).action, "passthrough");
});
