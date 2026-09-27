# 0017. Biome for lint and format, `tsc --noEmit` for types

- Status: Accepted
- Date: 2026-09-26
- Plan: D17 (PLAN §2)

## Context

The repo needs linting, formatting and type checking that run fast locally, in CI on three
operating systems, and from a Claude Code `PostToolUse` formatter hook after every edit.
ESLint + Prettier + typescript-eslint means several tools and configs and slower runs.

## Decision

Biome (`biome.json`) handles lint and format in one tool; `npm run lint` runs
`biome check --error-on-warnings .` so warnings fail. Notable rules: `noUndeclaredDependencies`
(ADR 0018), `noExplicitAny`, `noProcessEnv` (env only in config modules), `noConsole`, and the
nursery `noFloatingPromises`/`noMisusedPromises`. Formatting enforces LF line endings.
TypeScript (`tsc --noEmit`, TypeScript 7) is the type checker only (ADR 0023).

## Consequences

### Positive

- One fast binary for lint + format; cheap to call from the edit hook.
- `npm run check` = lint + typecheck + test is one command everywhere.

### Negative

- Biome has fewer type-aware rules than typescript-eslint; promise rules are nursery-level.
- Biome skips Markdown and YAML here, so docs and workflows are not format-checked.
- If a needed rule is missing, typescript-eslint must be added later.

## Revisit when

Phase 2 review: add typescript-eslint only if Biome misses a rule we need (for example
floating promises).

## References

- PLAN §3 (stack), §10 (tasks 0.1, 0.2, 0.5)
- `biome.json`, root `package.json` scripts
- ADR 0018, 0023
