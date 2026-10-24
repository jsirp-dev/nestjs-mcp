# Issue tracker: GitHub Issues

Issues for this repo live in GitHub Issues of `jsirp-dev/nestjs-mcp`, driven with the `gh` CLI
(`gh issue list`, `gh issue view <n>`, `gh issue create`).

The development plan is not an issue: it lives in `docs/plans/` (one document per phase). Issues are
for bugs, requests and anything found while executing a phase that does not belong to it.

## Conventions

- One issue per problem or request; the title names the thing, in the glossary's vocabulary.
- Triage state is a label (see `triage-labels.md`).
- A spec written for an issue (by `to-spec`) goes in the issue body or a linked comment, not in the repo.

## When a skill says "publish to the issue tracker"

`gh issue create --title "<title>" --body "<body>" --label needs-triage`.

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --comments`. The user will normally pass the number or the URL.

## PRs as a request surface

Off. External pull requests are not treated as triage requests; only issues are.
