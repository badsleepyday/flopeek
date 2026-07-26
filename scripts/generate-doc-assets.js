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
  const baselineReport = readJson("benchmarks/orientation-baseline.json");
  const flopeekReport = readJson("benchmarks/orientation-flopeek.json");
  const baseline = baselineReport.summary;
  const flopeek = flopeekReport.summary;
  const refreshed = new Date(flopeekReport.generatedAt).toISOString().slice(0, 10);
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
    <text x="72" y="419" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="13">3 source-pinned fixtures · refreshed ${escapeXml(refreshed)} UTC · deterministic retrieval</text>
    <text x="72" y="440" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="12">No human-productivity, AI-outcome, or runtime-order claim</text>`;
  writeAsset("orientation-capabilities.svg", shell("What the graph adds", "Literal retrieval finds files; Flopeek adds ordered static flow and versioned context.", content, 470));
}

function performanceAsset() {
  const proof = readJson("benchmarks/public-proof.json");
  const rows = proof.incrementalPerformance.rows;
  const chartLeft = 135;
  const chartRight = 1080;
  const chartTop = 205;
  const chartBottom = 430;
  const timingValues = rows.flatMap((row) => [row.fullMedianMs, row.incrementalMedianMs]);
  const minimumExponent = Math.floor(Math.log10(Math.min(...timingValues)));
  const maximumExponent = Math.max(minimumExponent + 2, Math.ceil(Math.log10(Math.max(...timingValues))));
  const xFor = (index) => rows.length === 1 ? (chartLeft + chartRight) / 2 : chartLeft + (chartRight - chartLeft) * index / (rows.length - 1);
  const yFor = (milliseconds) => {
    const normalized = (Math.log10(milliseconds) - minimumExponent) / (maximumExponent - minimumExponent);
    return chartBottom - normalized * (chartBottom - chartTop);
  };
  const fullPoints = rows.map((row, index) => `${xFor(index).toFixed(1)},${yFor(row.fullMedianMs).toFixed(1)}`).join(" ");
  const incrementalPoints = rows.map((row, index) => `${xFor(index).toFixed(1)},${yFor(row.incrementalMedianMs).toFixed(1)}`).join(" ");
  const tickLabel = (milliseconds) => {
    if (milliseconds >= 60000) return `${milliseconds / 60000} min`;
    if (milliseconds >= 1000) return `${milliseconds / 1000} s`;
    return `${milliseconds} ms`;
  };
  const ticks = Array.from(
    { length: maximumExponent - minimumExponent + 1 },
    (_, index) => 10 ** (minimumExponent + index),
  ).map((milliseconds) => {
    const y = yFor(milliseconds);
    return `<line x1="${chartLeft}" x2="${chartRight}" y1="${y}" y2="${y}" stroke="#ffffff" stroke-opacity=".10"/>
      <text x="${chartLeft - 16}" y="${y + 4}" text-anchor="end" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="11">${tickLabel(milliseconds)}</text>`;
  }).join("");
  const points = rows.map((row, index) => {
    const x = xFor(index);
    const fullY = yFor(row.fullMedianMs);
    const incrementalY = yFor(row.incrementalMedianMs);
    return `<g>
      <circle cx="${x}" cy="${fullY}" r="6" fill="#8aa2ff" stroke="#172a55" stroke-width="3"/>
      <circle cx="${x}" cy="${incrementalY}" r="6" fill="#8ef0cf" stroke="#172a55" stroke-width="3"/>
      <text x="${x}" y="466" text-anchor="middle" fill="#ffffff" font-family="Inter,Segoe UI,sans-serif" font-size="13" font-weight="700">${escapeXml(row.repository)}</text>
      <text x="${x}" y="484" text-anchor="middle" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="10">${escapeXml(row.sourceFiles.toLocaleString("en-US"))} files</text>
      <text x="${x}" y="${Math.max(chartTop + 14, incrementalY - 12)}" text-anchor="middle" fill="#8ef0cf" font-family="Inter,Segoe UI,sans-serif" font-size="11" font-weight="800">${escapeXml(row.speedup.toFixed(2))}×</text>
    </g>`;
  }).join("");
  const refreshed = escapeXml(proof.updatedAt.slice(0, 10));
  const content = `<g>
    ${ticks}
    <polyline points="${fullPoints}" fill="none" stroke="#8aa2ff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    <polyline points="${incrementalPoints}" fill="none" stroke="#8ef0cf" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    ${points}
    <g transform="translate(735 167)">
      <line x1="0" x2="34" y1="0" y2="0" stroke="#8aa2ff" stroke-width="4"/><text x="44" y="4" fill="#c8d2e7" font-family="Inter,Segoe UI,sans-serif" font-size="12">Full reparse median</text>
      <line x1="190" x2="224" y1="0" y2="0" stroke="#8ef0cf" stroke-width="4"/><text x="234" y="4" fill="#c8d2e7" font-family="Inter,Segoe UI,sans-serif" font-size="12">Incremental reuse median</text>
    </g>
    <text x="72" y="522" fill="#b9c4dc" font-family="Inter,Segoe UI,sans-serif" font-size="12">All ${rows.length} pinned repositories · log-time axis · 3 samples per mode · refreshed ${refreshed} UTC</text>
    <text x="72" y="542" fill="#8592aa" font-family="Inter,Segoe UI,sans-serif" font-size="11">One supported unchanged file per checkout · one benchmark host · not a universal speed guarantee</text>
  </g>`;
  writeAsset("incremental-performance.svg", shell("Reuse the graph instead of rebuilding it", `Full reparse and incremental parser-fact reuse across all ${rows.length} pinned repositories.`, content, 570));
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
