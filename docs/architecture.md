# Architecture

A map of the codebase **as it exists**, kept current task by task. The target design lives in
[PLAN.md §3](PLAN.md#3-architecture), and decisions in [decisions/](decisions/README.md). This
page answers "where does X live today, and what may it depend on?". Terms are defined in the
[glossary](glossary.md).

**Keep it current:** a task that adds, moves or removes a module updates the tables below in the
same PR (`/finish-task` step 6). Only list modules that exist. Planned ones stay in PLAN.

## Runtime shape (target, PLAN §3)

```
browser (apps/web) ──WS + cookie──► server (apps/server) ──PTY──► provider CLI (claude, fake)
                                        ▲                              │
                                        └──── /hooks, /otel ◄──────────┘ (hook token)
          shared contract: packages/shared (schemas, reduce, severity, mood) on both sides
```

## Workspaces and dependency rules

| Workspace | Role | May depend on | Must not |
|---|---|---|---|
| `packages/shared` | Event and frame schemas, `reduce()`, severity rules, `mood()` | `zod` only | Do I/O, import `node:*`, read time or randomness (hard rule 9) |
| `packages/hook-relay` | Fail-open hook command for CLIs without HTTP hooks | Node built-ins | Write to stdout, exit non-zero, add startup work before the env check (hard rule 5) |
| `apps/server` | Sessions, PTYs, worktrees, ingest, event store, WS | `@micro-minds/shared`, Fastify, `ws`, node-pty, better-sqlite3 | Put provider logic outside `src/providers/<name>/`, or read `process.env` outside `src/config/` |
| `apps/web` | Board, inbox, terminal drawer, scene | `@micro-minds/shared`, React, R3F, zustand, xterm.js | Hold business logic in components, or render agent text as HTML (`SEC-terminal-escape`) |

Imports only go *into* `packages/shared`, never out of it. Apps never import each other.

## Modules that exist today

| Path | What it is | Added in |
|---|---|---|
| `packages/shared/src/provider.ts` | `PROVIDERS`, `Provider`, `isProvider()` | 0.1 |
| `packages/shared/src/events.ts` | `AgentEvent`, `EventKind`, `ToolCategory`, usage types; the versioned event schema and `parseAgentEvent()` (explicit result, unknown kinds → `unknown`) | 2.1 |
| `packages/shared/src/frames.ts` | §8 WS frames in both directions, versioned (`PROTOCOL_VERSION`): `parseServerFrame()`, `parseClientFrame()` | 2.1 |
| `packages/shared/src/state.ts` | `AgentState`, `WorldState` and the snapshot's world schema | 2.1 |
| `packages/shared/src/thresholds.ts`, `severity.ts` | `Thresholds` / `DEFAULT_THRESHOLDS` (§6) and the health rules: failure window, repeated failures, stuck, recovery, errors | 2.1 |
| `packages/shared/src/reduce.ts` | `createWorld()` and the pure `reduce()` (§4.3); time only via `clock.tick` | 2.1 |
| `packages/shared/src/scrub.ts` | The scrubber (D14): `scrubText()` for `text` and `tool.summary`, `scrubRaw()` for the stored `raw` (scrubbed, then size-capped) | 2.2 |
| `apps/server/src/providers/types.ts` | `ProviderAdapter` (binary, hook transport, tool-category map, `launch()`, `normalize()`), `LaunchContext`/`LaunchSpec`, `NormalizeContext` | 2.3 |
| `apps/server/src/providers/registry.ts` | `createProviderRegistry()`: lookup, `categorize()`, `resolveBinary()` (absolute PATH entries only, PATHEXT on Windows, `.cmd`/`.bat` reported as `cmd`), and `normalize()` that validates, scrubs and caps every adapter event (fallback `unknown`) | 2.3 |
| `apps/server/src/providers/conformance.test-helpers.ts` | The adapter conformance suite: `describeConformance()` and its checks as pure functions | 2.3 |
| `fixtures/agent-events/` | Provider-independent `AgentEvent` scenarios (the Phase 1 recordings, plus `clock.tick` scenarios) replayed through `reduce()` | 2.1 |
| `packages/hook-relay/src/main.ts` | Fail-open no-op relay entry (invariant test only) | 0.1 |
| `apps/server/src/pty/pty.smoke.test.ts` | node-pty/ConPTY smoke test; no server code yet | 0.3 |
| `apps/web/src/App.tsx`, `main.tsx` | Placeholder React shell | 0.1 |
| `scripts/fix-node-pty.ts` | postinstall: restores the exec bit on node-pty's macOS `spawn-helper` | 0.10 |
| `scripts/lint-commits.ts` | Conventional Commits check for commits and PR titles (CI job `commits`); `npm run lint:title` | PR #4 |
| `scripts/tests-locked.ts` | The test lock (ADR 0028): fails if a test path changed after the task's `Test-lock:` commit; `npm run tests:locked -- <id>` | PR #9 |
| `spikes/phase-1/` | Throwaway Phase 1 hook capture: loopback sink, fail-open relay, `--settings` generator, PTY recording driver, scratch-repo setup ([README](../spikes/phase-1/README.md)). Deleted by the PR that closes Phase 2 | 1.1 |

## Harness (not shipped with the app)

| Path | What it is |
|---|---|
| `.claude/settings.json` | Permissions and hook registration |
| `.claude/hooks/` | `guard.ts` (PreToolUse), `format.ts` (PostToolUse), `session-context.ts` (SessionStart) |
| `.claude/agents/` | `reviewer`, `test-writer` |
| `.claude/skills/` | `start-task`, `finish-task`, `run-phase`, `phase-status`, `new-adapter`, `record-fixture` |
| `evals/harness/` | Guard, reviewer, coverage-schedule, session-context, integrity and doc tests |

Details are in [dev-harness.md](dev-harness.md).
