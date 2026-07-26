# Releasing Flopeek Core

`main` is the only long-lived public source branch. It is the canonical
Flopeek Core that users clone, test, review, and extend.

## Release channels

Release channels are immutable tags on commits already present on `main`:

| Channel | Example tag | GitHub Release state |
| --- | --- | --- |
| Alpha | `v0.3.0-alpha.1` | prerelease |
| Beta | `v0.3.0-beta.1` | prerelease |
| Release candidate | `v0.3.0-rc.1` | prerelease |
| Stable | `v0.3.0` | latest release |

Do not create a permanent public `alpha` or `beta` branch. Short-lived feature,
fix, and documentation branches are merged through pull requests and removed
after merge. A temporary hotfix branch is allowed only when a tagged stable line
needs a fix while `main` has moved ahead.

## Branch naming and lifecycle

Every short-lived branch uses `<type>/<change-name>`, where `<change-name>` is
lowercase and may contain numbers, dots, underscores, or hyphens. Allowed SDLC
types are:

- `feature/` for product capability work;
- `fix/` and `hotfix/` for defect remediation;
- `docs/` for documentation-only work;
- `release/` for release preparation;
- `chore/`, `build/`, `ci/`, `deps/`, `test/`, `refactor/`, `perf/`, and
  `security/` for their corresponding engineering work.

Tool, vendor, account, or agent identity prefixes are prohibited. In particular,
never create `codex/`, `agent/`, or personal-name branches. CI runs the
repository-owned `scripts/verify-branch-name.js` validator and rejects names
outside this contract. Delete the short-lived branch immediately after its pull
request is merged or closed.

## Release procedure

1. Merge the reviewed change to `main` after the required CI checks pass.
2. Record the owner decision in
   [`packaging/github-release-approval.json`](packaging/github-release-approval.json).
   A beta, release candidate, or stable decision must name the exact tag,
   package version, brand decision, manual Viewer review, six role artifacts,
   and at least four distinct recorded provider IDs. This record is an explicit
   maintainer attestation; its references remain independently reviewable
   evidence, not parser facts or an automated proof of provider independence.
3. For beta, release candidate, and stable channels, publish the exact approved
   package first. The tagged-release workflow checks that the public npm
   dist-tag resolves to that same version. An alpha may remain source-only.
4. Create an annotated semantic-version tag on the approved `main` commit.
5. Push the tag. The release workflow fails closed until the approval record,
   source/package checks, and required registry check pass; only then does it
   create the GitHub Release and mark prerelease tags as prereleases.

Creating a tag does not bypass this gate. The workflow never runs `npm publish`;
registry publication retains its separate exact owner approval gate.

## Private overlay boundary

Commercial and confidential work belongs in a separate private overlay
repository. It consumes a pinned public Core tag and must not copy or become an
alternative source of truth for `src/`, `public/`, or the Core test suite.
Core defects discovered privately are reproduced safely and fixed through a
public Core pull request first.
