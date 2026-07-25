# ADR-006: Deterministic semantic flow suggestions

## Status

Accepted.

## Context

Flow Lens already exposes bounded static HTTP/request steps, roles, parser-edge evidence, and boundaries. People still have to translate those technical facts into a short title and purpose before verification. Doing that with an opaque model would weaken Flowpeek's local, deterministic trust boundary and make unsupported interpretations difficult to distinguish from evidence.

## Decision

`src/semantic-flow-suggestion.js` produces `flowpeek-semantic-flow-suggestion/v1` from one current Flow Lens. It uses only a literal HTTP method/route, displayed technical roles, direct transition IDs, static boundaries, and current Context Refs. It returns either:

- `suggested`, with candidate title, technical purpose, request role, grouping, confidence, reasons, and evidence references; or
- `abstained`, with a stable code, reason, and missing evidence.

The algorithm does not read source bodies, execute target code/configuration, call an external model, or infer runtime/business behavior. The same result is embedded in Flow Lens, Flow Context Cards, Markdown packets, agent context, and the viewer. `/api/flow-suggestion` provides direct HTTP composition without adding another MCP tool because `get_flow_projection` and `get_agent_context` already expose it.

Suggestions use the `derived-suggestion` knowledge class. The viewer may copy a suggestion into unsaved verification fields, but only the existing explicit human save action can create an immutable `human-verified` record. Suggestion generation never calls the verification store.

## Consequences

Candidate wording is intentionally conservative and route-oriented. Unsupported entries, wildcard/dynamic routes, missing endpoint evidence, and ambiguous subjects abstain. A committed contract corpus protects deterministic behavior but is not evidence that the candidate captures business purpose. Acceptance, edit, rejection, and abstention feedback remain a later evaluation layer.
