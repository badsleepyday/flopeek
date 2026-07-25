"use strict";

const DEFAULT_FLOW_LENS_MAX_STEPS = 12;
const MAX_FLOW_LENS_STEPS = 24;
const MIN_FLOW_LENS_STEPS = 1;
const MAX_STEPS_ERROR_MESSAGE = `maxSteps must be an integer from ${MIN_FLOW_LENS_STEPS} through ${MAX_FLOW_LENS_STEPS}.`;

class FlowLensOptionsError extends Error {
  constructor(message = MAX_STEPS_ERROR_MESSAGE) {
    super(message);
    this.name = "FlowLensOptionsError";
    this.code = "invalid-flow-lens-max-steps";
  }
}

function validateFlowLensMaxSteps(value = DEFAULT_FLOW_LENS_MAX_STEPS) {
  if (!Number.isSafeInteger(value) || value < MIN_FLOW_LENS_STEPS || value > MAX_FLOW_LENS_STEPS) throw new FlowLensOptionsError();
  return value;
}

function parseFlowLensMaxStepsQuery(value) {
  if (value === null || value === undefined) return DEFAULT_FLOW_LENS_MAX_STEPS;
  if (typeof value !== "string" || !value.length) throw new FlowLensOptionsError();
  const parsed = Number(value);
  if (String(parsed) !== value) throw new FlowLensOptionsError();
  return validateFlowLensMaxSteps(parsed);
}

module.exports = {
  DEFAULT_FLOW_LENS_MAX_STEPS,
  FlowLensOptionsError,
  MAX_FLOW_LENS_STEPS,
  MAX_STEPS_ERROR_MESSAGE,
  MIN_FLOW_LENS_STEPS,
  parseFlowLensMaxStepsQuery,
  validateFlowLensMaxSteps,
};
