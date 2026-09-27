# CLAUDE.md — micro-minds

A local, single-user web app. It runs AI coding CLI sessions (Claude Code for the MVP; Gemini and Codex later) in embedded terminals, and shows every agent and subagent as a character alongside a status board.

**Source of truth for scope and order of work: `docs/PLAN.md`.** Read the relevant task before starting. Don't build features from later phases early.

## Commands

- `npm run dev`: run server and web in watch mode
- `npm run check`: lint (Biome, warnings are errors), typecheck (`tsc` 7) and test (Vitest). **Must pass before any task is done.**
- `npm test` (all packages) · `npm test -w @micro-minds/<pkg>` (one package)
- `npm run e2e`: Playwright smoke tests, fake provider only (added in task 3.9)
- `npm run test:coverage`: tests with coverage thresholds (also in CI)
- `npm run lint:commits`: check commit subjects on your branch against Conventional Commits (CI checks commits and the PR title)
- `npm run eval:harness`: AI-harness evals (PLAN §11.1)

## Layout

- `packages/shared`: zod schemas, severity rules, **pure** `reduce()`. No I/O.
- `packages/hook-relay`: fail-open hook command, only for providers without native HTTP hooks.
- `apps/server`: Fastify, ws, node-pty, SQLite. Adapters live in `src/providers/<name>/`.
- `apps/web`: React, R3F, zustand, xterm.js.
- `fixtures/<provider>/*.jsonl`: recorded, scrubbed hook payloads. The test backbone.
- `docs/protocols/<provider>.md`: verified facts about each CLI's hooks (with the CLI version).
- `docs/glossary.md`: precise meanings of session, agent, activity, health, attention, mood and the credential types. `docs/architecture.md`: map of the code as it exists.
- `docs/dev-harness.md`: how the Claude Code harness (settings, hooks, agents, skills, evals) works and how to change it.
- `docs/engineering-standards.md`: every engineering practice and the check that enforces it. Add a row when you introduce one.
- `docs/deferred-practices.md`: practices we chose not to adopt yet, with the trigger that brings each back. Search it before proposing a new tool, hook or process.
- `docs/decisions/`: ADRs. Add one for any decision that changes PLAN §2.
- Every package has its own short `CLAUDE.md`. Read it before editing that package.

## Hard rules (security and correctness)

1. **Never read, copy, log or proxy anything under `~/.claude`, `~/.gemini`, `~/.codex`,** or any credential or `.env` file. The dev harness exempts only Claude Code's own plans, memory and tool-results (ADR 0024, `docs/dev-harness.md`); app code gets no exemption.
2. **Never modify the user's global CLI config.** Inject hooks per session only (PLAN §5.2).
3. **Bind to `127.0.0.1` only.** The UI session cookie (from the one-time bootstrap, ADR 0026) and an Origin/Host check are required on every WS and control request. Served HTML never contains a secret.
4. **Hook tokens are per session and only valid on that session's ingest endpoints (`POST /hooks`, `POST /otel/*`).** They must never grant WS or control access.
5. **Hooks fail open.** The relay always exits 0, prints nothing to stdout, and times out fast.
6. **Adapters set facts only** (`kind`, `tool.category`, `errorClass`). Health and severity are derived in `packages/shared` only.
7. **Unknown provider events become `kind: 'unknown'`.** Never throw on them.
8. **Scrub** `tool.summary`, `text` and the stored `raw`. Cap the size of `raw`. Never send `raw` over the WS by default.
9. `reduce()` is pure. Time only enters through `clock.tick` events.
10. Every agent session runs in its own worktree under `~/.micro-minds/worktrees/`.
11. **Never delete a worktree, branch, or kill a process automatically.** Removal and orphan-killing are always explicit, confirmed user actions.
12. The app observes agents; it doesn't steer them (PLAN D19). Anything that changes agent behavior needs an ADR.

## Working style

- Plan first for anything touching more than two files. Stay inside the current task.
- **Tests first, by someone else** (ADR 0028): for every code change, a fresh `test-writer` writes failing tests from the task text only; they're committed and locked (`npm run tests:locked`), and the implementer never edits them. Fixture-driven where fixtures exist; a bug fix adds a fixture that reproduces it.
- Never call real provider CLIs in tests. Use the fake provider.
- Windows is first-class: use `path` APIs, not string concatenation; no POSIX-only shell in scripts; resolve `.cmd`/`.exe` binaries.
- Check current dependency versions when installing. Don't pin from memory.
- Start tasks with `/start-task <id>` and finish with `/finish-task`; they perform the steps below. Until the MVP ships (Phase 4a), run whole phases with `/run-phase <n>`, which does the same per task (ADR 0027). Claude pushes branches; the user merges.
- Before finishing: `npm run check` green, an adversarial `reviewer` pass that gets artifacts only (the task, its clauses, the diff command; never your summary or claims) and a security pass where due, eval cases for any reviewer rules due with the task (`evals/harness/reviewer/uncovered.json`; CI fails if they're overdue), a locked test commit then one conventional commit per task (`feat(server): …`), and the task's checkbox ticked in `docs/PLAN.md`.
- Harness changes follow the principles in `docs/dev-harness.md` (procedures and checks beat prose; add agents or hooks only on evidence).
- If the plan is wrong or ambiguous, stop and say so. Propose the plan edit rather than guessing.

## Code conventions

- TypeScript strict, ESM, no `any`. Use `unknown` plus zod parsing at every boundary (hook payloads, WS frames, env, config).
- Node runs `.ts` directly (PLAN D23): relative imports use the `.ts` extension, and there are no `enum`s, `namespace`s or parameter properties (`erasableSyntaxOnly`). Use `as const` objects and union types instead.
- Read `process.env` only in config modules (`apps/server/src/config/`), where it's parsed with zod. Biome enforces this.
- Each workspace declares every package it imports, dev tools included (Biome `noUndeclaredDependencies`).
- IDs: ULID. Timestamps: ms epoch, stamped by the server.
- Usage and cost come only from the CLI's telemetry (PLAN §5.7). Never compute cost from a price table, never read transcripts for it, and always label cost as API-equivalent (`≈ $`) in the UI.
- UI state flows one way: WS → store → shared `reduce()` → components. Scene components read `AgentState` only and hold no business logic.
