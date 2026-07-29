"use strict";

const { evaluateNativeDefaultRollout } = require("./native-rollout-gate");

const CORE_MODE_SCHEMA = "flopeek-core-mode/v1";
const CORE_MODES = Object.freeze(["js", "shadow", "native"]);

class CoreModeError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoreModeError";
    this.code = "invalid-core-mode";
  }
}

function requestedCoreMode(value = process.env.FLOPEEK_CORE) {
  const normalized = String(value || "js").trim().toLowerCase();
  if (!CORE_MODES.includes(normalized)) {
    throw new CoreModeError(`FLOPEEK_CORE must be one of ${CORE_MODES.join(", ")}; received ${JSON.stringify(value)}.`);
  }
  return normalized;
}

// Selection is deliberately separate from activation. A caller can make the
// requested mode visible before it starts any process, and native remains
// impossible to select without the complete rollout evidence plus an actual
// public-core implementation.
function selectCoreMode(options = {}) {
  const requestedMode = requestedCoreMode(options.mode);
  const gate = evaluateNativeDefaultRollout(options.rolloutEvidence || {});
  const nativeAvailable = options.nativeAvailable === true;
  if (requestedMode === "js") {
    return Object.freeze({
      schemaVersion: CORE_MODE_SCHEMA,
      requestedMode,
      selectedImplementation: "javascript",
      nativeShadow: false,
      fallback: null,
      gate,
    });
  }
  if (requestedMode === "shadow") {
    return Object.freeze({
      schemaVersion: CORE_MODE_SCHEMA,
      requestedMode,
      selectedImplementation: "javascript",
      nativeShadow: true,
      fallback: null,
      gate,
    });
  }
  if (gate.eligible && nativeAvailable) {
    return Object.freeze({
      schemaVersion: CORE_MODE_SCHEMA,
      requestedMode,
      selectedImplementation: "native",
      nativeShadow: false,
      fallback: Object.freeze({
        reason: "native-runtime-fallback-required",
        required: "automatic-javascript-fallback-required",
        gateReasons: Object.freeze([]),
      }),
      gate,
    });
  }
  const reason = gate.eligible
    ? "native-public-core-unavailable"
    : "native-rollout-gate-blocked";
  return Object.freeze({
    schemaVersion: CORE_MODE_SCHEMA,
    requestedMode,
    selectedImplementation: "javascript",
    nativeShadow: false,
    fallback: Object.freeze({
      reason,
      required: "automatic-javascript-fallback-required",
      gateReasons: gate.reasons,
    }),
    gate,
  });
}

module.exports = {
  CORE_MODE_SCHEMA,
  CORE_MODES,
  CoreModeError,
  requestedCoreMode,
  selectCoreMode,
};
