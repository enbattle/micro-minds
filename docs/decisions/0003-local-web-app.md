# 0003. Local web app bound to 127.0.0.1

- Status: Accepted
- Date: 2026-09-26
- Plan: D3 (PLAN §2)

## Context

The app must be trivial to run from a clone and cross-platform, and it needs a native PTY
layer plus a rich 3D UI. Options: a desktop shell from day one (Electron/Tauri) or a Node
server plus a browser tab. Multi-user or remote access is a non-goal (PLAN §1).

## Decision

A Node server (`apps/server`: Fastify, `ws`, node-pty, better-sqlite3) serves a browser UI
(`apps/web`: Vite, React, R3F) on `127.0.0.1` only. The whole stack is TypeScript in one npm
workspaces repo; the workflow is `git clone && npm install && npm run dev`.

## Consequences

### Positive

- No packaging work for the MVP; one language across server, shared code and UI.
- The server and UI split cleanly, so an Electron wrapper later is mostly packaging (Phase 8).

### Negative

- A localhost server is reachable by other local processes and by web pages via DNS rebinding
  or cross-site WebSockets. Mitigated by binding to `127.0.0.1` only (refuse otherwise), a UI
  token on every WS and control request, and `Origin`/`Host` checks (PLAN §9).
- No native notifications or tray until Phase 8; browser notifications are the fallback.

## Revisit when

Phase 8 (packaging: Electron shell, tray, native notifications).

## References

- PLAN §1, §3, §9
- ADR 0013
