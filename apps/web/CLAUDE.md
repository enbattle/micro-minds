# apps/web

Vite + React + React Three Fiber + zustand + xterm.js.

- **One-way data flow:** WS → zustand store → shared `reduce()` → components. Components never mutate world state directly.
- **The board is primary, the scene is a skin** (PLAN D8). Every feature must work with the scene hidden.
- Scene components read `AgentState` and `mood()` only. No business logic, no health computation, no timers deciding state.
- Validate every inbound WS frame with the shared zod schemas. Never render `raw` payloads.
- Keyboard shortcuts must not steal keys from a focused xterm (PLAN §7).
- The dev server binds to `127.0.0.1` with `strictPort`. Don't change that.
- Tests: `npm test -w @micro-minds/web`
