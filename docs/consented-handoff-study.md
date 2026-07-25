# Consented handoff study protocol

Use this protocol only with repository-owner permission and a participant who has agreed to the study. It prepares a bounded quality report; it does not simulate a study, collect telemetry, or persist participant data.

## Preconditions

- Work from a current Flopeek graph for the permitted repository.
- Use a participant role only: `senior-developer`, `inheriting-developer`, `handoff-recipient`, or `agent-reviewer`. Do not provide a name, email, employee ID, transcript, source body, raw log, credential, or machine path.
- Give the participant a bounded task and Context Packet. Retain the Flow Context Ref or node Context Ref that framed that task.
- Measure elapsed time outside Flopeek, then round it to whole milliseconds. Flopeek does not start a timer or observe the participant.

## Report one observation

Send a `POST /api/handoff-quality` request with `requireHumanHandoffObservation: true`. A case may include this privacy-minimized observation:

```json
{
  "result": "located",
  "evidenceClass": "human-observation",
  "consent": "confirmed",
  "participantRole": "inheriting-developer",
  "observedDurationMs": 1850,
  "evidenceRef": "fp://local/project-id/flow/flow-id@7"
}
```

`result` is `located`, `not-located`, or `inconclusive`. The evidence ref must resolve in the current project history. The API rejects unknown observation fields, missing consent, personal/free-text fields, non-loopback/unresolvable context, and durations outside one day.

The returned quality report separately exposes `humanHandoffObservations.timeToLocate` for `located` observations only; `not-located` and `inconclusive` counts remain visible but are never folded into a success-time average. It does not alter parser facts, semantic suggestions, human flow verification, runtime evidence, or agent task outcomes. A `located` observation means only that the caller reported the participant found the bounded target; it is not independent proof of correctness.

## Retention and reporting

Flopeek intentionally does not persist these study observations. Store the returned report only in the separately approved research/hand-off record, with the repository revision, study consent record held by the research owner, and independent reviewer decision. Do not place that record in `.flopeek` unless the organization explicitly approves the retention policy.

Report at least: case count, target-located/not-located/inconclusive counts, observed time-to-locate summary, Context Packet budget, stale-context detection, evidence-ref traceability, and outcome evidence class. State the number of unavailable observations rather than treating them as success.

## Interpretation limits

One study, one participant role, or one repository cannot prove general handoff quality. The protocol does not execute code, capture runtime behavior, access shell commands, or infer a human result from graph retrieval. Production/CI validation remains a separate consented activity.
