# Clean-room package protocol

## Purpose

Iteration 34 tests the exact npm tarball that a prospective user would install. It answers a bounded question:

> Can the current Flopeek package be packed, installed into an empty temporary project, and used for its basic CLI and MCP contracts without relying on the source checkout or executing the target application?

This protocol does not publish the package and is not a release approval. The
package carries public beta metadata, but its `prepublishOnly` gate rejects an
ordinary `npm publish` until the exact owner approval record is changed. No
license, registry permission, or package-name ownership is inferred.

## Package boundary

[`packaging/package-policy.json`](../packaging/package-policy.json) is the source-controlled allowlist. The tarball may contain only:

- runtime modules under `src/`;
- framework-free Viewer assets under `public/`;
- the canonical Flopeek host skill under `integrations/skills/flopeek/`;
- the bounded checkout showcase under `examples/commerce-showcase/`;
- 14 explicitly named machine-readable public benchmark/template artifacts under `benchmarks/`; a new JSON file is excluded until both npm and policy allowlists are deliberately updated;
- approved public Markdown and generated documentation assets under the root and `docs/`;
- npm-always-included `README.md` and `package.json`.

The audit rejects repository governance, `.git`, `.github`, `.flopeek`, `.agents`, `.agent-team`, `node_modules`, environment/credential filenames, logs, source maps, key/certificate suffixes, missing runtime files, an unexpected binary path, a changed package identity, an exceeded entry/size bound, or removal of the prepared-publication metadata and explicit prepublish approval gate.

Run the inventory-only audit:

```powershell
npm run test:package
npm run audit:package
```

`npm run audit:package` uses `npm pack --dry-run --json`; it creates no tarball and performs no installation.

## Clean-room sequence

Run:

```powershell
npm run verify:clean-room
```

The verifier:

1. creates an operating-system temporary workspace;
2. packs the repository into that workspace and applies the committed allowlist;
3. copies the committed checkout fixture without changing the original;
4. creates an empty private consumer package;
5. installs the exact tarball with `--ignore-scripts`, `--no-audit`, `--no-fund`, and no lockfile;
6. resolves the installed `flopeek` binary through local offline `npm exec`;
7. checks `--version` and help output;
8. runs non-strict `doctor` and retains only bounded counts;
9. runs `scan --no-cache --format json` against the copied fixture;
10. connects to the installed MCP entry point, lists tools, and calls `get_agent_bootstrap`;
11. verifies that non-cache fixture content has the same SHA-256 fingerprint before and after;
12. removes the entire temporary workspace, including tarball, installation, copied fixture, and Flopeek cache.

The verifier never runs the fixture application, its package scripts, its tests, a provider, a browser, or an npm publication command. npm registry access may occur only while resolving Flopeek dependencies for the isolated install. Installation lifecycle scripts are disabled.

## Evidence

`flopeek-clean-room-package-report/v1` is defined by [`flopeek-clean-room-package-report.schema.json`](schemas/flopeek-clean-room-package-report.schema.json). An explicit maintenance run may refresh the excluded evidence file:

```powershell
npm run update:clean-room-evidence
```

The checked report lives at `packaging/evidence/clean-room-current.json`, outside the npm package allowlist. This avoids a recursive artifact hash in which adding a report changes the tarball it claims to identify.

The report contains package identity, entry count, size, tarball SHA-256, host-specific phase observations, bounded CLI/scan/MCP results, copied-fixture fingerprints, cleanup status, and explicit no-publication/no-target-execution boundaries. It contains no source body, raw command log, credential, environment variable, registry token, machine-local path, participant identity, or AI-provider output.

## CI and interpretation

The ordinary CI matrix runs the package tests, dry-run inventory audit, and clean-room verifier on Node 22 and Node 24. A local Windows pass plus future CI passes provide platform-specific observations; neither proves every operating system or shell.

A passing report proves one tarball can complete the declared clean-room sequence. It does not prove npm publication permission or package-name availability, licensing approval, upgrade compatibility, every adapter on every host, target runtime correctness, business intent, universal performance, or alpha/beta/stable readiness.
