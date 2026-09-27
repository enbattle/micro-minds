# 0018. npm workspaces (not pnpm)

- Status: Accepted
- Date: 2026-09-26
- Plan: D18 (PLAN §2)

## Context

The repo is a monorepo (`packages/shared`, `packages/hook-relay`, `apps/server`, `apps/web`,
scope `@micro-minds/*`). pnpm offers strict dependency isolation, but it's an extra tool to
install (or enable via Corepack) on every machine, including Windows. npm ships with Node.

## Decision

Use npm workspaces declared in the root `package.json` (`packages/*`, `apps/*`) with a single
committed `package-lock.json`. Because npm hoists and does not stop a package from importing a
dependency it never declared, the gap is covered by:

- Biome `noUndeclaredDependencies` as an error: each workspace declares everything it
  imports, dev tools included.
- `npm ci` in CI, installing exactly the lockfile.
- `engine-strict=true` in `.npmrc` with `engines.node >=24`; also `save-exact=true`.

## Consequences

### Positive

- `git clone && npm install && npm run dev` with nothing else to install.
- Dependabot and CI work on the one root lockfile.

### Negative

- No strict isolation: phantom dependencies are caught by lint, not by the package manager,
  and only for imports Biome can see (not dynamic `require` or tool configs).
- Hoisting can hide version conflicts between workspaces.
- Installs are slower and `node_modules` larger than with pnpm.

## Revisit when

Install or hoisting problems appear.

## References

- PLAN §3 (repo layout, stack), §15
- Root `package.json`, `.npmrc`, `biome.json`, `.github/workflows/ci.yml`
- ADR 0017
