# CLAUDE.md — micro-minds

A local, single-user web app. It runs AI coding CLI sessions (Claude Code for the MVP; Gemini and Codex later) in embedded terminals, and shows every agent and subagent as a character alongside a status board.

**Source of truth for scope and order of work: `docs/PLAN.md`.** Read the relevant task before starting. Don't build features from later phases early.

## Commands

- `npm run dev`: run server and web in watch mode
- `npm run check`: lint (Biome, warnings are errors), typecheck (`tsc` 7) and test (Vitest). **Must pass before any task is done.**
- `npm test` (all packages) · `npm test -w @micro-minds/<pkg>` (one package)
- `npm run e2e`: Playwright smoke tests, fake provider only (added in task 3.9)
- `npm run eval:harness`: AI-harness evals (PLAN §11.1)

## Layout

- `packages/shared`: zod schemas, severity rules, **pure** `reduce()`. No I/O.
- `packages/hook-relay`: fail-open hook command, only for providers without native HTTP hooks.
- `apps/server`: Fastify, ws, node-pty, SQLite. Adapters live in `src/providers/<name>/`.
- `apps/web`: React, R3F, zustand, xterm.js.
- `fixtures/<provider>/*.jsonl`: recorded, scrubbed hook payloads. The test backbone.
- `docs/protocols/<provider>.md`: verified facts about each CLI's hooks (with the CLI version).
- `docs/decisions/`: ADRs. Add one for any decision that changes PLAN §2.
- Every package has its own short `CLAUDE.md`. Read it before editing that package.

## Hard rules (security and correctness)

1. **Never read, copy, log or proxy anything under `~/.claude`, `~/.gemini`, `~/.codex`,** or any credential or `.env` file.
2. **Never modify the user's global CLI config.** Inject hooks per session only (PLAN §5.2).
3. **Bind to `127.0.0.1` only.** The UI token and an Origin/Host check are required on every WS and control request.
4. **Hook tokens are per session and only valid for `POST /hooks` for that session.** They must never grant WS or control access.
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
- **Tests first** for `packages/shared` and adapters, driven by fixtures. A bug fix adds a fixture that reproduces it.
- Never call real provider CLIs in tests. Use the fake provider.
- Windows is first-class: use `path` APIs, not string concatenation; no POSIX-only shell in scripts; resolve `.cmd`/`.exe` binaries.
- Check current dependency versions when installing. Don't pin from memory.
- Before finishing: `npm run check` green, a `reviewer` subagent pass on the diff, one conventional commit per task (`feat(server): …`), and the task's checkbox ticked in `docs/PLAN.md`.
- If the plan is wrong or ambiguous, stop and say so. Propose the plan edit rather than guessing.

## Code conventions

- TypeScript strict, ESM, no `any`. Use `unknown` plus zod parsing at every boundary (hook payloads, WS frames, env, config).
- Node runs `.ts` directly (PLAN D23): relative imports use the `.ts` extension, and there are no `enum`s, `namespace`s or parameter properties (`erasableSyntaxOnly`). Use `as const` objects and union types instead.
- Read `process.env` only in config modules (`apps/server/src/config/`), where it's parsed with zod. Biome enforces this.
- Each workspace declares every package it imports, dev tools included (Biome `noUndeclaredDependencies`).
- IDs: ULID. Timestamps: ms epoch, stamped by the server.
- UI state flows one way: WS → store → shared `reduce()` → components. Scene components read `AgentState` only and hold no business logic.
