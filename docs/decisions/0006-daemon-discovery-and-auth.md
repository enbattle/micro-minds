# 0006 — Daemon discovery mechanism and request authentication

Status: Accepted

## Decision

- **Local state directory:** `~/.micro-minds/` holds everything the daemon
  owns: the SQLite database, the append-only JSONL backstop, and a discovery
  file, `~/.micro-minds/daemon.json`.
- **Discovery file, not a hardcoded port:** on startup, the daemon tries a
  preferred default port (`47285`) and falls back to any free port if that
  one's taken. Whatever port it actually binds is written to
  `daemon.json`, along with a fresh auth token, the daemon's PID, and a
  start timestamp:

  ```json
  {
    "port": 47285,
    "token": "<64 hex chars>",
    "pid": 12345,
    "startedAt": "2026-01-01T00:00:00.000Z"
  }
  ```

  `daemon.json` is written with `0600` permissions. No consumer — hook
  scripts, the UI, the MCP server, the `doctor` command — ever assumes a
  port number. All of them read this file to find the daemon.

- **Token regenerates every daemon startup.** It's a 32-byte random value
  (`crypto.randomBytes(32).toString('hex')`), not persisted across restarts.
  Consumers read it fresh from `daemon.json` rather than caching it
  indefinitely; a request that fails auth should trigger a re-read of the
  file (the daemon may have restarted) before giving up.
- **Every request to the daemon must carry the token** (e.g. an
  `Authorization: Bearer <token>` header) — this applies to REST calls, the
  WebSocket handshake, and the MCP server's calls into the daemon's API.
  Requests without a valid token are rejected.

## Alternatives considered

- **Hardcoded default port, no discovery file.** Simpler, but principle 10
  explicitly rules this out: any later need for configurability (e.g. two
  daemons for two projects) would mean touching every consumer. Not
  choosing this now to avoid that retrofit.
- **No auth, rely on `127.0.0.1` binding alone.** Rejected per principle 9 —
  binding to localhost stops another _machine_ from reaching the daemon, not
  another local process or a malicious web page's request to a `localhost`
  port. Given this daemon serves real captured source code and prompts, that
  gap is worth closing cheaply now rather than treating it as acceptable
  residual risk.
- **A persistent, long-lived token instead of one that rotates per
  restart.** Considered, but a token that only lives as long as the daemon
  process is simpler to reason about and slightly reduces the value of a
  leaked token (e.g. via a stale process's leftover file) without adding
  real friction to any consumer, since every consumer already has to read
  `daemon.json` for the port.

## Why

This is the single concrete decision every later phase's code depends on
agreeing to — hook scripts (Phase 1), the daemon itself (Phase 2), the MCP
server (Phase 2.5), and the UI (Phase 4) all need one shared answer to
"where is the daemon and how do I authenticate to it," decided once, here,
rather than each consumer inventing its own convention.
