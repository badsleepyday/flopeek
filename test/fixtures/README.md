# Flopeek fixture corpus

Each directory is a small repository scanned by Flopeek. `expectations.json` describes parser facts that are important enough to score:

- `endpoints`: detected endpoint label and confidence;
- `relationships`: direct `imports`, `handles`, `requests`, `declares-command-target`, `schedules`, or exact `calls` edges using `file:<relative path>`, `endpoint:<METHOD route>`, `command:<manifest>:<script>`, `schedule:<path>:<task>`, or `symbol:<relative path>:<type>:<label>` references;
- `minimumPrecision` and `minimumRecall`: per-fixture regression thresholds.

Run `npm.cmd run test:fixtures` to calculate the corpus metrics. The scorer only evaluates edge types and source nodes declared by the fixture so unrelated inventory facts do not distort the relationship metric.

Keep fixtures representative, small, and deterministic. This is an internal regression corpus; it must not be presented as an external benchmark without a documented sampling method.
