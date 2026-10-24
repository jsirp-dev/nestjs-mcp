# ADR-0003: The package is an inspector; it never exposes business logic as tools

**Status**: accepted
**Date**: 2026-10-25

## Context

Two families of packages carry "nestjs" and "mcp" in their names. One turns a Nest app's own
functionality into MCP tools an agent can call (`nestjs-mcp`, `@rekog/mcp-nest`): the app becomes an
MCP server for its domain. The other, which this package belongs to, exposes the running app itself so
an agent can understand and debug it. Both are useful; they have different security models, different
users and different lifetimes, and a module that does both invites business endpoints behind a switch
that is meant to be off in production.

## Decision

`@jsirp/nestjs-mcp` is an inspector only. Its tools read what Nest built and what the app is doing;
none of them calls into the app's domain. The tool registry is internal: the host app cannot add tools
of its own. Only MCP tools are offered (no resources or prompts in v1), and each answers JSON as text.

## Consequences

- The scope stays small and the name stays honest: the README can promise "nothing leaves your
  process and nothing in here calls your business code".
- Apps that want to expose their domain to agents use a package built for that, possibly alongside
  this one on another endpoint.
- The public API surface is `NestMcpModule` and its options; no tool authoring API has to be stabilised
  or versioned.
- If a future need for app-defined *inspection* tools appears, it comes back as its own decision with
  an explicit `tools` option, not by exporting the registry.

## Alternatives considered

- **Both in one module**: more features for the same install, at the cost of an endpoint that mixes
  "show me the inside" with "do things", and of a tool authoring API to maintain.
- **An open registry from day one**: cheap to export, expensive to keep compatible, and it turns the
  endpoint into a generic tool host, which is the first alternative in disguise.
