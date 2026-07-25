"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs", "assets");
const CHECK = process.argv.includes("--check");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function writeAsset(name, body) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const file = path.join(OUTPUT, name);
  const content = `${body.trim()}\n`;
  if (CHECK) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) throw new Error(`Documentation asset is stale: ${path.relative(ROOT, file)}`);
    return;
  }
  fs.writeFileSync(file, content, "utf8");
}

function shell(title, description, content, height = 520) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(title)}</title>
  <desc id="description">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101a33"/><stop offset="1" stop-color="#172a55"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#081126" flood-opacity=".18"/></filter>
  </defs>
  <rect width="1200" height="${height}" rx="28" fill="#f6f8fc"/>
  <rect x="28" y="28" width="1144" height="${height - 56}" rx="22" fill="url(#panel)" filter="url(#shadow)"/>
  <text x="72" y="82" fill="#9fb4ff" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="700" letter-spacing="2">FLOPEEK · EVIDENCE SNAPSHOT</text>
  <text x="72" y="122" fill="#ffffff" font-family="Inter,Segoe UI,sans-serif" font-size="28" font-weight="750">${escapeXml(title)}</text>
  <text x="72" y="151" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="15">${escapeXml(description)}</text>
  ${content}
</svg>`;
}

function capabilityAsset() {
  const baseline = readJson("benchmarks/orientation-baseline.json").summary;
  const flopeek = readJson("benchmarks/orientation-flopeek.json").summary;
  const metrics = [
    ["Target paths", `${baseline.correctTargetRetrieval.matched}/${baseline.correctTargetRetrieval.expected}`, `${flopeek.correctTargetRetrieval.matched}/${flopeek.correctTargetRetrieval.expected}`],
    ["Ordered flow steps", "Not available", `${flopeek.flowSteps.matchedInExpectedOrder}/${flopeek.flowSteps.expected}`],
    ["Related tests", `${baseline.relatedTests.matched}/${baseline.relatedTests.expected}`, `${flopeek.relatedTests.matched}/${flopeek.relatedTests.expected}`],
    ["Versioned stale refs", "Not available", `${flopeek.staleContextDetection.detected}/${flopeek.staleContextDetection.requested}`],
  ];
  const cards = metrics.map(([label, direct, graph], index) => {
    const x = 72 + index * 267;
    return `<g transform="translate(${x} 190)">
      <rect width="239" height="196" rx="16" fill="#ffffff" fill-opacity=".07" stroke="#ffffff" stroke-opacity=".12"/>
      <text x="18" y="35" fill="#c8d2e7" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="650">${escapeXml(label)}</text>
      <text x="18" y="76" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="12">Literal retrieval</text>
      <text x="18" y="104" fill="${direct === "Not available" ? "#e3a7ad" : "#ffffff"}" font-family="Inter,Segoe UI,sans-serif" font-size="21" font-weight="750">${escapeXml(direct)}</text>
      <line x1="18" x2="221" y1="124" y2="124" stroke="#ffffff" stroke-opacity=".12"/>
      <text x="18" y="151" fill="#9fb4ff" font-family="Inter,Segoe UI,sans-serif" font-size="12">Flopeek graph</text>
      <text x="18" y="181" fill="#8ef0cf" font-family="Inter,Segoe UI,sans-serif" font-size="24" font-weight="800">${escapeXml(graph)}</text>
    </g>`;
  }).join("");
  const content = `${cards}
    <text x="72" y="425" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="13">Three source-pinned fixtures · deterministic retrieval · no human or AI outcome claim</text>`;
  writeAsset("orientation-capabilities.svg", shell("What the graph adds", "Literal retrieval finds files; Flopeek adds ordered static flow and versioned context.", content, 470));
}

function performanceAsset() {
  const proof = readJson("benchmarks/public-proof.json");
  const rows = proof.incrementalPerformance.rows;
  const max = Math.max(...rows.map((row) => row.speedup));
  const chart = rows.map((row, index) => {
    const y = 190 + index * 68;
    const width = Math.max(18, Math.round(row.speedup / max * 760));
    return `<g>
      <text x="72" y="${y + 19}" fill="#ffffff" font-family="Inter,Segoe UI,sans-serif" font-size="15" font-weight="700">${escapeXml(row.repository)}</text>
      <rect x="190" y="${y}" width="760" height="26" rx="8" fill="#ffffff" fill-opacity=".08"/>
      <rect x="190" y="${y}" width="${width}" height="26" rx="8" fill="#6f8cff"/>
      <text x="${Math.min(970, 202 + width)}" y="${y + 19}" fill="#8ef0cf" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="800">${escapeXml(row.speedup.toFixed(2))}×</text>
      <text x="1050" y="${y + 18}" text-anchor="end" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="12">${escapeXml(row.sourceFiles.toLocaleString("en-US"))} files</text>
    </g>`;
  }).join("");
  const content = `${chart}
    <text x="190" y="464" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="12">Median parser-fact reuse speedup vs full reparse · one supported changed file · one benchmark host</text>`;
  writeAsset("incremental-performance.svg", shell("Reuse the graph instead of rebuilding it", "Incremental scan speedups across four pinned real repositories.", content, 500));
}

function workflowAsset() {
  const boxes = [
    [72, "Repository", "Supported parser facts"],
    [300, "Flow Lens", "Bounded static path"],
    [528, "Context Ref", "Project + graph version"],
    [756, "Viewer + MCP", "One shared context"],
    [984, "Refresh", "Changed + stale context"],
  ];
  const content = `${boxes.map(([x, title, detail], index) => `<g transform="translate(${x} 210)">
      <rect width="172" height="110" rx="17" fill="${index === 2 ? "#294ba8" : "#ffffff"}" fill-opacity="${index === 2 ? ".9" : ".08"}" stroke="#9fb4ff" stroke-opacity="${index === 2 ? ".9" : ".25"}"/>
      <text x="18" y="43" fill="#ffffff" font-family="Inter,Segoe UI,sans-serif" font-size="17" font-weight="750">${escapeXml(title)}</text>
      <text x="18" y="70" fill="${index === 2 ? "#dfe6ff" : "#b9c4dc"}" font-family="Inter,Segoe UI,sans-serif" font-size="12">${escapeXml(detail)}</text>
      ${index < boxes.length - 1 ? `<path d="M 176 55 H 213" stroke="#8ef0cf" stroke-width="3"/><path d="M 205 48 L 214 55 L 205 62" fill="none" stroke="#8ef0cf" stroke-width="3"/>` : ""}
    </g>`).join("")}
    <text x="72" y="378" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="13">Static evidence stays static. Human verification, test results, runtime observations, and agent declarations stay separate.</text>`;
  writeAsset("shared-context-workflow.svg", shell("One repository context. Two readers.", "People and coding agents resolve the same versioned technical evidence.", content, 420));
}

capabilityAsset();
performanceAsset();
workflowAsset();
console.log(`${CHECK ? "Checked" : "Generated"} documentation assets in ${path.relative(ROOT, OUTPUT)}.`);
