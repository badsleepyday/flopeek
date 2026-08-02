"use strict";

const { scanRepository } = require("./scanner");

function compare(left, right) {
  return left.localeCompare(right);
}

function nativeRustShadowProjection(root) {
  const graph = scanRepository(root);
  const rustPaths = new Set(graph.nodes.filter((node) => node.kind === "file" && node.language === "rs").map((node) => node.path));
  const included = new Set(graph.nodes.filter((node) => node.kind === "file" && rustPaths.has(node.path)).map((node) => node.id));
  for (const node of graph.nodes) {
    if (node.kind === "symbol" && rustPaths.has(node.path)) included.add(node.id);
  }
  for (const edge of graph.edges) {
    if (edge.type === "imports" && included.has(edge.source) && edge.target.startsWith("external:")) included.add(edge.target);
  }
  return {
    schemaVersion: "flopeek-native-rust-graph-shadow/v1",
    nodes: [...included].sort(compare),
    edges: graph.edges
      .filter((edge) => ["contains", "imports", "calls"].includes(edge.type) && included.has(edge.source) && included.has(edge.target))
      .map((edge) => ({ type: edge.type, source: edge.source, target: edge.target }))
      .sort((left, right) => `${left.type}\0${left.source}\0${left.target}`.localeCompare(`${right.type}\0${right.source}\0${right.target}`)),
  };
}

module.exports = { nativeRustShadowProjection };
