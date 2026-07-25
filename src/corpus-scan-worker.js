"use strict";

const { scanRepository } = require("./scanner");

const root = process.argv[2];
const focuses = JSON.parse(Buffer.from(process.argv[3] || "", "base64url").toString("utf8"));
const wanted = new Set(focuses.map((focus) => `${focus.source}|${focus.type}`));
const graph = scanRepository(root);
const edges = graph.edges.filter((edge) => wanted.has(`${edge.source}|${edge.type}`));
process.stdout.write(JSON.stringify({ project: graph.project, stats: graph.stats, edges }), () => process.exit(0));
