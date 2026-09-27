# 0023. Node runs TypeScript directly (native type stripping)

- Status: Accepted
- Date: 2026-09-26
- Plan: D23 (PLAN §2)

## Context

Server, shared and relay code is TypeScript. Compiling it (`tsc` emit, `tsx`, bundlers) adds
build steps, output directories, source maps and watch-mode complexity. Node 24 strips type
annotations natively, so `.ts` files can run directly. Only the browser app genuinely needs a
bundler.

## Decision

Node runs `.ts` directly for `apps/server`, `packages/shared`, `packages/hook-relay`, scripts
and evals. There is no emitted JS and no `tsx`. Only `apps/web` has a build step (`vite build`).
`tsconfig.base.json` sets `erasableSyntaxOnly`, `allowImportingTsExtensions`,
`verbatimModuleSyntax` and `noEmit`; relative imports use the `.ts` extension. `tsc --noEmit`
(TypeScript 7) is used for type checking only. Node >= 24 is enforced via `engines` +
`engine-strict` and `.node-version` (also used by CI).

Native dependencies are unaffected by this choice. Verified in task 0.3: node-pty 1.1.0
installed on Windows 11 using bundled prebuilds (prebuilds exist for win32-x64, win32-arm64,
darwin-x64 and darwin-arm64), so no Visual Studio Build Tools were needed; Linux builds from
source. The ConPTY smoke test `apps/server/src/pty/pty.smoke.test.ts` passes locally.

## Consequences

### Positive

- No build output for server/shared/relay; faster dev loop and simpler scripts.
- Stack traces point at real source lines.

### Negative

- No `enum`s, `namespace`s or parameter properties; use `as const` objects and union types.
- `.ts` import extensions everywhere, which some tools handle less smoothly.
- Types are never checked at runtime; `npm run check` (`tsc --noEmit`) must pass.
- Packages can't be published as-is (consumers would need emitted JS).

## Revisit when

A published package ever needs emitted JS.

## References

- PLAN §3 (stack), task 0.1, task 0.3
- CLAUDE.md code conventions
- `tsconfig.base.json`, `.node-version`
- ADR 0011, 0017
