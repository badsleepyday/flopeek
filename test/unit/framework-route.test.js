"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { frameworkRoute, nextRoute, svelteRoute } = require("../../src/framework-route");

test("framework route adapter derives exact Next.js route-handler paths", () => {
  assert.deepEqual(nextRoute("src/app/api/orders/route.ts"), { kind: "route", route: "/api/orders", handler: true, framework: "next" });
  assert.deepEqual(nextRoute("src/app/(internal)/teams/[team]/[...slug]/route.ts"), { kind: "route", route: "/teams/:team/*slug", handler: true, framework: "next" });
  assert.deepEqual(nextRoute("src/app/route.ts"), { kind: "route", route: "/", handler: true, framework: "next" });
  assert.equal(nextRoute("src/app/api/orders/page.tsx"), null);
});

test("framework route adapter derives exact SvelteKit route paths and refuses unrelated plus files", () => {
  assert.deepEqual(svelteRoute("src/routes/(portal)/members/[id]/+server.ts"), { kind: "server", route: "/members/:id", handler: true, framework: "sveltekit" });
  assert.deepEqual(svelteRoute("src/routes/docs/[...path]/+page.svelte"), { kind: "page", route: "/docs/*path", handler: false, framework: "sveltekit" });
  assert.deepEqual(svelteRoute("src/routes/+layout.svelte"), { kind: "layout", route: "/", handler: false, framework: "sveltekit" });
  assert.equal(svelteRoute("src/lib/+server.ts"), null);
  assert.equal(svelteRoute("src/routes/docs/+error.svelte"), null);
  assert.deepEqual(frameworkRoute("src/app/api/health/route.ts"), { kind: "route", route: "/api/health", handler: true, framework: "next" });
});
