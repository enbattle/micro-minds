# apps/server

Fastify + `ws` + node-pty + better-sqlite3. It owns sessions, PTYs, worktrees, hook ingest, the event store, the clock, and the authoritative world state.

- **Security first** (PLAN §9, CLAUDE.md hard rules 1–4):
  - Bind to `127.0.0.1` only.
  - The UI session cookie (one-time bootstrap code → HttpOnly cookie, ADR 0026) plus Origin/Host checks guard the WS and control routes. Never put a secret in served HTML.
  - Hook tokens are per session and only valid on that session's `POST /hooks` and `POST /otel/*`.
  - Compare tokens in constant time.
  - Every boundary (HTTP body, WS frame, env, hook payload) is parsed with zod.
- `process.env` is read only in `src/config/` (Biome enforces this). Everything else receives typed config.
- Provider-specific code lives only in `src/providers/<name>/`. Adapters emit facts, never health (hard rule 6), and must pass the shared conformance suite.
- Never delete worktrees or branches, or kill processes, without an explicit user action (hard rule 11). Kill process trees on Windows, not just the root pid.
- Windows is first-class: `node:path` for every path, resolve `.cmd`/`.exe` binaries, no POSIX-only shell.
- Tests use temporary git repos and the fake provider. Never the real CLIs.
- Tests: `npm test -w @micro-minds/server`
