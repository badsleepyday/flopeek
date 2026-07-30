# Native Core Completion Tracker

This tracker is the machine-verification index for the Native Core final stabilization charter. A gate is marked `passing` only after its listed commands have exited successfully and its raw evidence exists. Source inspection alone is never sufficient.

## Baseline

- Charter baseline: `a891b964b225cd79673b5a9a76699a0c65ab3a28`
- Starting implementation SHA: `2af4c4d6e0e19a325ad9667ba0b2ea36dd862243`
- Branch: `feature/rust-core-baseline`

## Gate status

| Gate | Status | Closing commit | Verification commands | Raw evidence / blocker |
| --- | --- | --- | --- | --- |
| 1. Native correctness and incremental matrix | pending | — | `cargo test --locked --manifest-path native/flopeek-core/Cargo.toml`; `node --test test/unit/core-client.test.js`; `node --test test/unit/native-incremental-coordinator.test.js` | Test output and incremental matrix artifact pending |
| 2. Exact adapter parity | pending | — | `npm run verify:native-adapter-parity` | `packaging/evidence/native-adapter-parity.json` pending |
| 3. Exact toolchains | pending | — | toolchain contract verification in CI | `rust-toolchain.toml`, `global.json`, and candidate compiler metadata pending |
| 4. CI, candidate, and promotion separation | pending | — | workflow contract tests; candidate bundle verification; promotion dry-run | Candidate run and immutable bundle pending |
| 5. External approval without circular source digest | pending | — | promotion dry-run and approval/provenance validation | Protected Environment is an external manual setting; automated dry-run pending |
| 6. Real-repository correctness corpus | pending | — | pinned-corpus verifier | Raw per-repository results pending |
| 7. Failure and recovery | pending | — | native failure-injection and recovery tests | Test output pending |
| 8. Surface contracts | pending | — | `npm run verify:native-surfaces` | Machine-generated surface matrix pending |
| 9. Performance and resource stability | pending | — | candidate benchmark/profile/database evidence validators; persistent and cache-disabled soak | Candidate-bound raw samples and RSS series pending |
| 10. Package and clean-room proof | pending | — | six-platform candidate clean-room checks and promotion dry-run | Candidate bundle and registry dry-run evidence pending |
| 11. Seven-day dogfooding | blocked | — | seven consecutive days, 10 repositories, 500+ refreshes, three OS families | Time-based external evidence does not yet exist; normal/default native remains blocked |

## Rollout state

`BLOCKED — NATIVE NOT READY`

The rollout remains blocked until every automated gate passes and Gate 11 has genuine time-based dogfood evidence with zero open P0/P1 incidents. No generated or manually edited boolean may override missing evidence.
