"use strict";

function analyzeInventory(relativePath, extension) {
  const subject = extension === ".makefile"
    ? "Makefile build-control files"
    : extension === ".asm"
      ? "assembly source files"
      : extension || "this file type";
  return {
    imports: [],
    endpoints: [],
    requests: [],
    calls: [],
    methods: [],
    symbols: [],
    analysis: { parser: "inventory", status: "inventory-only", confidence: "not-analyzed", reason: `No structural adapter registered for ${subject}.` },
  };
}

function analyzeGoFact(fact, relativePath) {
  if (!fact) return analyzeInventory(relativePath, ".go");
  const evidence = (range) => ({ parser: "go-parser", file: relativePath, range });
  return {
    imports: (fact.imports || []).map((item) => ({ specifier: item.specifier, standard: Boolean(item.standard), evidence: evidence(item.range) })),
    endpoints: [],
    requests: [],
    calls: (fact.calls || []).map((call) => ({
      name: call.name,
      source: call.source || null,
      imported: call.imported || null,
      evidence: evidence(call.range),
    })),
    methods: [...new Set(fact.methods || [])].slice(0, 12),
    symbols: (fact.symbols || []).map((symbol) => ({ type: symbol.type, name: symbol.name, methods: symbol.methods || [], evidence: evidence(symbol.range) })),
    analysis: {
      parser: "go-parser",
      status: fact.status || "parse-failed",
      confidence: String(fact.status || "").startsWith("parsed") ? "exact" : "not-analyzed",
      diagnostics: Number(fact.diagnostics || 0),
      ...(fact.reason ? { reason: fact.reason } : {}),
    },
  };
}

function analyzeCSharpFact(fact, relativePath) {
  if (!fact) return analyzeInventory(relativePath, ".cs");
  const evidence = (range) => ({ parser: "csharp-static-ast", file: relativePath, range });
  return {
    imports: (fact.imports || []).map((item) => ({ specifier: item.specifier, evidence: evidence(item.range) })),
    endpoints: [],
    requests: [],
    calls: [],
    methods: fact.methods || [],
    symbols: (fact.symbols || []).map((symbol) => ({ type: symbol.type, name: symbol.name, methods: symbol.methods || [], evidence: evidence(symbol.range) })),
    analysis: {
      parser: "csharp-static-ast",
      status: fact.status || "parse-failed",
      confidence: String(fact.status || "").startsWith("parsed") ? "exact" : "not-analyzed",
      diagnostics: Number(fact.diagnostics || 0),
      ...(fact.reason ? { reason: fact.reason } : {}),
    },
  };
}

module.exports = { analyzeCSharpFact, analyzeGoFact, analyzeInventory };
