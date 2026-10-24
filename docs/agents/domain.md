# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

This repo is **single-context**: one glossary, one set of ADRs, both at the repo root.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read the ADRs that touch the area you are about to work in.

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/            Decisions that were real trade-offs; carry a Status line
│   ├── plans/          The phased development plan (master plan + one doc per phase)
│   └── agents/         What the skills read: this file, the issue tracker, the triage labels
├── src/
└── test/
```

## Use the glossary's vocabulary

When your output names a concept (an issue title, a test name, a tool name, a refactor proposal), use
the term as defined in `GLOSSARY.md`. Do not drift to the synonyms the glossary explicitly avoids.

If the concept you need is not in the glossary yet, that is a signal: either you are inventing language
the project does not use (reconsider) or there is a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (tracing by wrapping enhancers), but worth reopening because…_

The package also follows a phased plan (`docs/plans/`) whose master plan lists closed decisions that are
not ADRs; treat those the same way.
