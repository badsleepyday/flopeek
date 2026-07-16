# Human review and verification protocol

This protocol turns Flowpeek's deterministic semantic suggestions into a small, privacy-safe human-review cohort. It does **not** turn feedback into business verification, runtime proof, or permission to train a model.

## Before collecting a record

1. Obtain permission from the repository owner to review the selected flows and retain only the aggregate label metadata described below.
2. Start Flowpeek locally and scan the repository. Keep repository paths, remote URLs, source bodies, prompt text, credentials, and raw command logs out of the evaluation dataset.
3. Define the cohort before reviewing: use 20–30 current HTTP/request flows from at least three repositories. Today, place all 20+ measured cases in `held-out`, because Flowpeek has no trained model. If a future model uses training data, create a new split before any model fitting and never reuse a case across splits.
4. Use opaque aliases such as `repo-a`, `reviewer-01`, and `case-001`. The evaluator intentionally rejects filesystem paths, URLs, and free-text fields.

## Review one flow

1. In the viewer or MCP, open the Flow Lens with `get_flow_projection`. Read its static evidence, boundaries, limitations, and deterministic suggestion or abstention.
2. Inspect only the supporting local code needed to judge the technical wording. Do not copy it into Flowpeek feedback or the dataset.
3. Record an agent evidence trace after any relevant test or inspection. Its Context Ref must match the Flow Lens before it can be linked to the feedback record.
4. In Flow Lens, submit feedback with your reviewer pseudonym:

   - `accepted`: title, technical purpose, role, and grouping are useful technical wording supported by the displayed static evidence;
   - `edited`: the candidate is useful but needs a replacement technical candidate; provide a concise reason and all replacement fields;
   - `rejected`: the candidate conflicts with, overstates, or is not supported by the displayed static evidence; provide a concise reason;
   - `abstained`: Flowpeek correctly declined to suggest; mark the abstention `appropriate` in the private cohort. If enough static evidence existed for a conservative suggestion, mark it `unnecessary`.

5. Human verification is separate. Use the existing flow-verification action only when a person can attest to the flow-level claim. A semantic feedback label never verifies runtime behavior, business intent, or test success.

## Verify the cohort

For every evaluated case, copy [the template](templates/semantic-suggestion-reviewed-dataset.template.json) to a **private, untracked** JSON file, then change `template` to `false`. The record contains only opaque IDs, split, suggestion status, decision, abstention verdict when relevant, and optional test/trace outcome (`passed`, `failed`, or `not-run`). It intentionally contains no candidate prose or source-derived text. The checked-in template can be evaluated to learn the output format, but can never pass the gate.

Use at least two reviewer pseudonyms across the held-out cohort. For a quality check, have a second reviewer independently inspect a small random sample outside the dataset, resolve disagreements, and keep any discussion in the repository owner's approved system—not in Flowpeek metadata.

Run the gate against the private file:

```powershell
npm.cmd run evaluate:reviewed-feedback -- --dataset C:\private\review.flowpeek-reviewed.json --require-gate
```

The gate is eligible only when it sees all of the following in held-out records:

| Requirement | Gate |
| --- | --- |
| Cohort | at least 20 cases, 3 repository aliases, and 2 reviewer pseudonyms |
| Suggestion coverage | at least 12 suggestions and 4 abstentions |
| Suggestion usefulness | accepted + edited at least 80%; rejected at most 10% |
| Abstention | at least 90% marked appropriate |
| Evidence | at least 70% trace-linked and 50% with a passed trace |

`NOT ELIGIBLE` is an expected result for an incomplete or failing cohort. Do not present it as a quality score or use it to recommend a model. Review the failed lines, collect additional consented records or correct the process, then run the gate again.

## What the gate proves—and does not prove

It reports a declared, privacy-safe human-review sample. It does not prove reviewer identity, business-process correctness, runtime behavior, test completeness, or generalization beyond the cohort. Do not add a trained model until the dataset is independently reviewed, a training/held-out split is locked before fitting, and the held-out result is reproduced.
