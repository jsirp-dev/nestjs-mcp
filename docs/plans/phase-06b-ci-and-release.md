# Phase 6b — CI matrix and release workflow

> Master plan: [`00-overview.md`](./00-overview.md)
> Previous phase: [`phase-06-events-and-schedule.md`](./phase-06-events-and-schedule.md)
> Next phase: [`phase-07-host-validation-and-publish.md`](./phase-07-host-validation-and-publish.md)

## Objective

Every push and pull request to `jsirp-dev/nestjs-mcp` runs lint, type-check, build and the suite on
**Nest 10 and Nest 11**, each on **Node 20 and Node 22**. Creating a version tag publishes the package
to npm from GitHub Actions with provenance. The peer range stops being a promise and becomes a tested
fact.

At the end: `ci.yml` is green on `main` with its four matrix cells, and `release.yml` has been
exercised with `npm publish --dry-run` on a test tag (the real publish is phase 7).

## Prerequisites

- [ ] Phase 6 closed.
- [ ] The GitHub repo exists with `main` pushed; an `NPM_TOKEN` secret (automation token, publish
      rights on `@jsirp`) added by Jorge; the npm package name free (checked in planning).

## Closed decisions for this phase

- **Matrix**: `nest: [10, 11]` × `node: [20, 22]`. The Nest 10 cell installs `@nestjs/common@^10`,
  `@nestjs/core@^10`, `@nestjs/platform-express@^10`, `@nestjs/testing@^10` with `yarn add -D` before
  running, in the checkout's own `yarn.lock` (the package has one for standalone work).
- **One workflow for checks, one for release**: `ci.yml` on `push` and `pull_request`; `release.yml`
  on `push` of tags `v*.*.*`, needing `id-token: write` for provenance, running the full matrix first.
- **The person creates tags** with `npm version patch|minor|major` (commit + tag) and pushes with
  `--follow-tags`; the workflow never bumps versions.
- **Branch protection** on `main` requiring `ci` to pass: recorded in the README's contributing notes;
  Jorge sets it in GitHub.

## Steps

### 1. `ci.yml`

`.github/workflows/ci.yml`: checkout, `actions/setup-node` with the matrix Node and yarn cache
(corepack enables yarn 4), `yarn install --immutable`, Nest 10 override step when `matrix.nest == 10`,
then `yarn format-check`, `yarn lint`, `yarn type-check`, `yarn build`, `yarn test`.

### 2. `release.yml`

`.github/workflows/release.yml`: on `v*.*.*` tags; reuses the CI job as a `needs`; then `yarn build`,
`npm publish --provenance --access public` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; a final
step writes the GitHub release from the matching `## x.y.z` section of `CHANGELOG.md`.

### 3. Package adjustments

`yarn.lock` committed in this repo for standalone installs (inside a host monorepo that lists this
folder as a workspace, the host's lock rules and this one is ignored). `README.md` contributing section: how to run
the suite on Nest 10 locally, how releases happen, branch protection.

## Files

### Created

- `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- `yarn.lock` (package repo)

### Modified

- `README.md`, `package.json` (`repository`, `bugs`, `homepage` fields complete)

## Verification / definition of done

- [ ] `ci.yml` green on `main` in all four cells (link to the run in the logbook).
- [ ] The Nest 10 cell really runs Nest 10: the job prints `require('@nestjs/core/package.json').version`
      starting with `10.`.
- [ ] `release.yml` validated with `act` or a `v0.0.0-test` tag and `--dry-run` (then the tag deleted),
      without publishing.
- [ ] `yarn install --immutable` passes standalone with the committed lock.

## Likely stumbles

- **Corepack and yarn 4 on Actions**: `corepack enable` before `yarn`; `packageManager` in
  `package.json` pins the version.
- **Nest 10 and `@nestjs/testing`** peer warnings: harmless; `yarn add -D` with explicit `^10` ranges
  for all four packages at once avoids a mixed tree.
- **Provenance** requires the workflow to run from the repository, not a fork, and `id-token: write`;
  `npm publish` from a fork PR must never run (`release.yml` is tag-only).
- **Husky in CI**: `postinstall` runs `husky` only when `.git` exists; on Actions it does, and it is
  harmless.

## Phase closure — two mandatory commits

Commit 1: `ci(nestjs-mcp): test on Nest 10 and 11 across Node 20 and 22, publish on tag (Phase 6b)`.
Commit 2: `chore(nestjs-mcp): close phase 6b`. Then, if a host embeds this repo as a submodule, its pointer on the host side.

## Notes for the next session (Phase 7)

- The first real tag (`v0.1.0`) is created in phase 7, after the host validation proves the package
  against real apps.
