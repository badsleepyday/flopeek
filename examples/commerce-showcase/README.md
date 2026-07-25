# Commerce checkout showcase

This small repository exists only to demonstrate Flopeek's current static evidence workflow. The showcase runner copies it into a temporary workspace and never executes this target application.

The primary flow starts at `POST /api/checkout` and connects checkout validation, inventory reservation, payment authorization, persistence, and order-created publication. A deterministic showcase change inserts a risk-review step so the local viewer can retain and display a before/current Flow Lens comparison.

`src/checkout/discount.ts` contains a computed dynamic import on purpose. Flopeek does not resolve that target and must not present the missing edge as proof that no runtime discount behavior exists.

This repository is a demonstration fixture. It is not independent benchmark evidence, runtime verification, business-intent verification, or a universal parser-support claim.
