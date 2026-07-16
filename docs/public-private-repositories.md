# Private development and public release repositories

Flowpeek uses three separate boundaries. They are not interchangeable.

| Boundary | Purpose | Contains |
| --- | --- | --- |
| Private development repository | Source of truth for implementation and validation | Product source, tests, internal agent roles, private workflows, unreleased evidence, release tooling |
| Public source repository | Reviewable product source and public contribution surface | Approved source, tests, public documentation, public CI, examples, portable Flowpeek configuration |
| npm package | Installable runtime | CLI, MCP server, Viewer, user documentation, declared examples, bounded public evidence |

## What stays private

The public export never includes:

- `.agents/`;
- `.agent-team/`;
- `AGENTS.md`;
- `.git/` or any private branch, tag, reflog, or commit history;
- Flowpeek cache files;
- credentials, environment files, logs, keys, or certificates;
- untracked files.

These files support development of Flowpeek. They are not Flowpeek product features and do not belong in its public release tree.

## What remains public-repository metadata

`.github/` is not automatically development-only. A public source repository normally needs public CI, security reporting, issue templates, and release automation. Flowpeek exports only explicitly approved public workflow files; it never copies the directory wholesale. The private CI is replaced by a public-source overlay that omits internal agent-contract checks.

`.flowpeek/config.json` is intentionally public. It is a portable dogfooding example that scopes `flowpeek serve .` for the Flowpeek source tree. Every other `.flowpeek` entry remains ignored and excluded. The npm package does not need this repository-local configuration.

## Why the repositories must not be mirrored

A Git mirror copies repository refs and history. That is useful when two repositories are intended to contain the same history, but it is unsafe when the source history is private. Flowpeek instead exports an allowlisted file snapshot and creates no `.git` directory. See GitHub's [repository mirroring behavior](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository).

The public repository keeps its own history:

```text
private commit
  -> tests and evidence gates
  -> allowlisted clean snapshot
  -> public-repository branch or pull request
  -> public release tag
  -> npm package publication gate
```

Do not force-push private history, use `git push --mirror`, or copy a private `.git` directory into the public repository.

## Branch promotion and protected public snapshots

The private development repository uses these branch roles:

| Private branch | Purpose | Public result |
| --- | --- | --- |
| `feature/*` | Isolated implementation and review | None |
| `development` | Integration branch for accepted feature work | None |
| `release/alpha` | Approved alpha candidate | Direct CI snapshot to public `alpha`, with an `alpha` prerelease version |
| `release/beta` | Approved beta candidate | Direct CI snapshot to public `beta`, with a `beta` prerelease version |
| `main` | Protected, verified, releasable private baseline | Owner-dispatched stable CI snapshot to public `main`, with a `patch`, `minor`, or `major` version |

Promote with pull requests, never by merging public work back into private history:

```text
feature/* -> development -> release/alpha -> release/beta -> main
```

`development` is the newest accepted integration state; it is not automatically a release. Private `main` is the source of truth for the newest stable, trusted, and releasable code. The public repository is a sanitized distribution copy and must never become the private repository's source of truth. Review happens before publication: every promotion into a private release branch or private `main` is reviewed as a pull request in the private repository.

The private workflow [`public-snapshot.yml`](../.github/workflows/public-snapshot.yml) runs automatically only after a reviewed merge reaches `release/alpha` or `release/beta`. It exports the allowlisted, history-free snapshot, calculates a SemVer prerelease with `alpha` or `beta` as the preid, and commits the snapshot directly to the matching public channel branch. A stable release is deliberately owner-dispatched from private `main`, choosing `patch`, `minor`, or `major`; CI then commits the stable snapshot directly to public `main`. A push to `development` or `feature/*` cannot create public source. The workflow never imports public history back into private history.

The workflow is deliberately disabled until all of these private-repository settings exist:

| Setting | Location | Required value |
| --- | --- | --- |
| `FLOWPEEK_PUBLIC_SYNC_ENABLED` | Actions variable | `true` |
| `FLOWPEEK_PUBLIC_SNAPSHOT_APPROVED` | Actions variable | `true` after owner, license, and release-policy approval |
| `FLOWPEEK_PUBLIC_REPOSITORY` | Actions variable | Public destination as `owner/repository` |
| `FLOWPEEK_PUBLIC_PUSH_TOKEN` | Actions secret | Fine-grained token limited to the public destination, with `Contents: write` |

Initialize public `main` once before enabling this workflow; an empty repository has no branch that CI can update. A one-file `README.md` commit is enough. That commit is a publication anchor, not Flowpeek source history: private Git objects are never copied or merged into public history. If the initial public branch has no `package.json`, CI seeds its first version from the exported snapshot. On first channel use, CI creates public `alpha` or `beta` from public `main` before publishing the sanitized channel snapshot. The public `main` branch holds stable source only. `alpha` and `beta` are explicitly non-stable source tracks. Create protected GitHub Environments named `flowpeek-public-alpha`, `flowpeek-public-beta`, and `flowpeek-public-stable` when an additional publication approval is required. Without the variables, approval, destination, and token, the workflow completes its preflight but does not export or push anything.

The public release branches receive a newly committed source snapshot, not a private commit, Git object, tag, or ref. The workflow never uses `git push --mirror`, does not copy `.git` into the snapshot, and never imports public history into private history.

## Audit the candidate

```powershell
npm run test:public-repository
npm run audit:public-repository
```

The audit reports structural safety separately from release readiness. A safe tree may still be blocked because a license has not been selected or `package.json` remains private.

## Export a clean snapshot

The private source worktree must be committed and clean. The destination must not exist and must be outside the private repository.

```powershell
npm run export:public-repository -- --output D:\release\flowpeek-public-candidate
```

The exporter:

1. reads only Git-tracked files from a clean private revision;
2. applies [`packaging/public-repository-policy.json`](../packaging/public-repository-policy.json);
3. copies regular files through a temporary sibling directory;
4. excludes internal agent governance and unsafe filenames;
5. creates no Git repository and performs no network operation;
6. reports license, package-private, and owner-approval boundaries.

For the first public release, initialize a new public repository from the reviewed snapshot. For later releases, apply the new snapshot to a branch in the existing public repository and review it as a pull request. This preserves public-only history without exposing private commits.

## Version and publication ownership

The public synchronization workflow calculates the snapshot version from the current public target branch. It runs `npm version prerelease --preid alpha|beta` for prerelease tracks, or owner-selected `npm version patch|minor|major` for a stable release dispatched from private `main`. This only changes the sanitized public snapshot; it does not create a private version commit, tag, GitHub Release, or npm publication. After the stable snapshot is published, the owner can create the matching public tag and separately approve npm publication. See the official [`npm version` contract](https://docs.npmjs.com/cli/commands/npm-version/).

Prereleases should use a non-`latest` distribution tag, such as `alpha` or `beta`. npm assigns `latest` by default unless publication specifies another tag. See [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).

Flowpeek currently remains blocked from public release because:

- no license has been selected;
- `package.json` still has `private: true`;
- no public `SECURITY.md`, `CONTRIBUTING.md`, or `CHANGELOG.md` exists;
- no owner release approval is recorded;
- npm package-name and registry publication decisions are not established.

Publishing source without a license does not make it open source. GitHub notes that default copyright restrictions remain when no license is provided. See [Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

No audit or export command chooses a license, changes repository visibility, creates a remote, pushes a commit, creates a release, or publishes an npm package.
