# packages/hook-relay

The command a provider CLI runs as its hook, for providers without native HTTP hooks (PLAN §5.1). Phase 1 decides whether Claude uses this at all.

- **Fail open, always** (CLAUDE.md hard rule 5): exit code 0 on every path, **nothing on stdout** (CLIs may treat stdout as hook output that changes agent behavior), and a hard network timeout of 300–500 ms.
- If the `MICROMINDS_*` env vars are missing, exit immediately. The CLI was started outside micro-minds.
- Only send the session's hook token. Never read any other credential.
- Keep startup cheap: no dependencies beyond Node built-ins, no top-level work before the env check.
- Windows: it must work when invoked through a `.cmd` shim.
- Tests: `npm test -w @micro-minds/hook-relay`. The fail-open invariant test must never be weakened.
