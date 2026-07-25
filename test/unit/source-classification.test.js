"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyFile, deriveDomain, deriveFeature, titleCase } = require("../../src/source-classification");

test("source classification assigns deterministic types, layers, labels, and responsibilities", () => {
  assert.deepEqual(classifyFile("src/app/api/orders/route.ts"), {
    type: "route",
    label: "Route /api/orders",
    layer: "application",
    detectedResponsibility: "Application entry point detected from the file structure or AST.",
  });
  assert.equal(classifyFile("src/services/payment-service.ts").type, "service");
  assert.equal(classifyFile("src/__tests__/payment.spec.ts").layer, "test");
  assert.equal(classifyFile("vite.config.ts").type, "config");
  assert.equal(classifyFile("src/contracts/order.d.ts").type, "declaration");
});

test("source classification derives portable domain and feature names", () => {
  assert.equal(titleCase("payment-service"), "Payment Service");
  assert.equal(deriveDomain("src/payment/service.ts"), "Payment");
  assert.equal(deriveDomain("src/app/page.tsx"), "Project");
  assert.equal(deriveFeature("src/app/api/orders/route.ts"), "api/orders");
  assert.equal(deriveFeature("src/components/receipt/card.tsx"), "ui/receipt");
  assert.equal(deriveFeature("src/lib/format.ts"), "library/shared");
  assert.equal(deriveFeature("src\\app\\api\\orders\\route.ts"), "api/orders");
});
