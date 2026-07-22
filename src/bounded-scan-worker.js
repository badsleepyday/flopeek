"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { scanRepository } = require("./scanner");
const { verifyAnalysisPlan } = require("./repository-discovery");

try {
  const graph = scanRepository(workerData.root, {
    persistIdentity: workerData.persistIdentity,
    initialFilePlan: workerData.analysisPlan.files,
    sessionProjectId: workerData.sessionProjectId || undefined,
  });
  const verification = verifyAnalysisPlan(workerData.root, workerData.analysisPlan);
  if (!verification.valid) {
    const error = new Error("Repository source inventory changed during bounded analysis; the graph was discarded.");
    error.code = verification.reason === "source-inventory-changed" || verification.reason === "source-directory-added"
      ? "repository-changed-during-analysis"
      : "analysis-plan-verification-failed";
    error.verification = verification;
    throw error;
  }
  parentPort.postMessage({ ok: true, graph, verification });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name || "Error",
      code: typeof error?.code === "string" ? error.code : null,
      message: error?.message || "Repository scan failed.",
      verification: error?.verification || null,
    },
  });
}
