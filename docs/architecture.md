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
| `apps/server/src/providers/hook-url.ts` | `hookEndpoint()`: `<server>/hooks?session=<sessionId>`, where every adapter's hooks post | 2.4 |
| `apps/server/src/providers/claude/adapter.ts` | `claudeAdapter`: per-session settings with 13 HTTP hooks (token read from the PTY env), and `normalize()` per `docs/protocols/claude.md` | 2.4 |
| `apps/server/src/providers/fake/adapter.ts`, `fake/cli.ts` | `fakeAdapter` and the fake CLI (`node cli.ts`): echoes its input and replays `fixtures/fake/<scenario>.jsonl` to `/hooks`, failing open | 2.4 |
| `apps/server/src/providers/index.ts` | `createDefaultRegistry()`: the Claude and fake adapters | 2.4 |
| `apps/server/src/config/fake-cli.ts` | The fake CLI's env, parsed with zod | 2.4 |
| `apps/server/src/ids.ts` | `newUlid()` | 2.6 |
| `apps/server/src/logging/logger.ts` | `createLogger()`: the pino conventions (token redaction paths, payloads only at debug, `child({ sessionId })` per session) | 2.6 |
| `apps/server/src/sessions/session-manager.ts` | `createSessionManager()`: worktree + PTY spawn, per-session hook token (`verifyHookToken`), launch files in `sessions/<id>/`, headless xterm with `snapshot()` (its query replies discarded), batched `onOutput`, `write`, `resize`, `stop` (Ctrl-C, grace, tree kill) and `kill`; `session.started`/`ended`/`crashed` events | 2.6 |
| `apps/server/src/sessions/binary.ts`, `tree-kill.ts` | What actually runs for a resolved binary (a `.cmd` shim's real target, or a refusal); killing a process tree (`taskkill /T`, or the process group) | 2.6 |
| `apps/server/src/sessions/preflight.ts` | `runPreflight()`: PATH lookup plus version command per provider | 2.6 |
| `apps/server/src/ingest/hook-ingest.ts` | `registerHookIngest()`: `POST /hooks?session=<id>` (413 → 404 → 401 → 429, then an empty 204; after it: parse, registry `normalize`, store, `onEvent`) | 2.7 |
| `apps/server/src/store/event-store.ts`, `migrations.ts` | `openEventStore()`: append-only SQLite events (no ticks), per-session reads with a cursor, retention `prune()`; versioned forward-only `migrate()` and `MIGRATIONS` | 2.7 |
| `apps/server/src/clock/clock.ts` | `createClock()`: one `clock.tick` per running session per interval | 2.7 |
| `apps/server/src/worktrees/git.ts`, `config/git-env.ts` | `runGit()`: the only way the server runs git (argv only, fsmonitor off, hooks path on the null device, inherited `GIT_*` dropped) | 2.5 |
| `apps/server/src/worktrees/worktree-manager.ts` | `createWorktreeManager({ home })`: `create` (`<home>/worktrees/<repo-slug>/<ULID>` on `micro-minds/<id>`), `list`, `isDirty`, and `remove` (registered, real-path checked, not locked, untracked links unlinked first and restored on failure, `git worktree remove` only, dirty needs `confirm`; the branch is kept) | 2.5 |
| `fixtures/fake/` | Fake-provider scenarios (`basic`, `subagent`) | 2.4 |
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
