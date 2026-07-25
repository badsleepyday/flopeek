# Releasing Flowpeek Core

`main` is the only long-lived public source branch. It is the canonical
Flowpeek Core that users clone, test, review, and extend.

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

## Release procedure

1. Merge the reviewed change to `main` after the required CI checks pass.
2. Run the public source and package verification from that exact commit.
3. Create an annotated semantic-version tag on that commit.
4. Push the tag. The release workflow verifies the tag and creates the GitHub
   Release, marking prerelease tags as prereleases.
5. If npm publishing is approved later, publish the exact tagged package with a
   channel-appropriate npm dist-tag. Publishing is never implied by a Git tag.

## Private overlay boundary

Commercial and confidential work belongs in a separate private overlay
repository. It consumes a pinned public Core tag and must not copy or become an
alternative source of truth for `src/`, `public/`, or the Core test suite.
Core defects discovered privately are reproduced safely and fixed through a
public Core pull request first.
