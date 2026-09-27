# packages/shared

The contract between every other package: zod schemas, types, `severity.ts` rules, the pure `reduce()` and the pure `mood()` selector.

- **No I/O and no side effects.** No `node:` imports, no `process`, no `Date.now()`, no `Math.random()`, no timers, no logging. Time arrives only as `clock.tick` events (PLAN D15). This package must run unchanged in the browser and on the server.
- **Tests first, by the test writer** (ADR 0028): the failing tests (usually fixture replays from `fixtures/<provider>/*.jsonl`) come from a fresh `test-writer` and are locked before the implementation; the implementer never edits them. Every bug fix adds a fixture that reproduces it.
- Health and severity are derived here and only here (CLAUDE.md hard rule 6). Thresholds live in one exported `Thresholds` object.
- Unknown input never throws: schemas parse into `kind: 'unknown'`.
- Keep the public surface explicit: export only through `src/index.ts`.
- Tests: `npm test -w @micro-minds/shared`
