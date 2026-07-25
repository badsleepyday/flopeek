# Runner adapter contract

`flowpeek-test-run-event/v1` is an observation protocol for a repository-owned test runner. It is not a command-execution API.

## Safe adapter sequence

1. Read the current Flow Lens and retain its `flow.id` and `flow.contextRef`.
2. Start the repository-owned test command outside Flowpeek and outside MCP shell access.
3. Append `run-started`, then optional `step-started` / `step-passed` events for displayed Flow Lens steps.
4. Append `step-failed` with the exact displayed step if the runner can establish that mapping, then append the terminal state as required by the journal.
5. If the graph changes, discard the old context and read a new Flow Lens before appending more events.

Each event needs a stable `operationId`, one `runId`, a sequence starting at zero, the current `expectedFlowContextRef`, a sanitized one-line summary, runner name, actor, and observation timestamp. A step event also needs a displayed `stepId` from the Flow Lens. The journal rejects stale contexts, invalid transitions, raw logs, credentials, source content, machine paths, and unknown schema fields.

The fixture [failing-flow-sequence.json](../test/fixtures/runner-adapter/failing-flow-sequence.json) is materialized by the unit test. `last-flow-step` is fixture notation only: a real adapter must resolve it to the exact step ID returned by the current Flow Lens. The fixture deliberately contains no command, source body, log body, or credential.

`test/fixtures/runner-adapter-repository` adds a separate package-level integration fixture. Its own `npm test` command intentionally fails one assertion after sending `run-started`, `step-started`, and `step-failed` only when all current Flow Lens identifiers and an explicit loopback endpoint are supplied. The integration test proves that the command keeps its non-zero exit status while the Flowpeek journal stores only the three concise declared events—not the assertion body or command output. This is a package-command proof, not a claim that a production CI runner has been validated.

## Boundary

The adapter reports an observed position, not runtime graph order or coverage. A missing mapping must remain unavailable. Flowpeek never invokes the test command through MCP; repository configuration and CI remain executable truth. The integration harness invokes its fixture command only as a test of the adapter boundary; that does not add command execution to the product or MCP surface.
