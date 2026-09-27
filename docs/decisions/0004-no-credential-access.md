# 0004. The app never touches credentials

- Status: Accepted
- Date: 2026-09-26
- Plan: D4 (PLAN §2)

## Context

Provider terms forbid third-party apps from intermediating subscription credentials.
Credentials live under `~/.claude`, `~/.gemini` and `~/.codex`. It would be tempting to read
those directories for session ids, login state or usage, but that would put the user's
accounts at risk and make the app a credential-handling tool.

## Decision

micro-minds never reads, copies, logs or proxies anything under the provider config
directories, any credential file or any `.env` file. Users log in to each CLI themselves
inside the embedded terminal. Preflight detects CLIs only by PATH lookup and `--version`,
never by reading credential files (PLAN §5.6). Resume ids come from hook payloads, not from
`~/.claude` (ADR 0020). This is enforced in code and in the dev harness: deny rules in
`.claude/settings.json` plus the `PreToolUse` guard `.claude/hooks/guard.mjs` (tasks 0.5, 0.6).

## Consequences

### Positive

- The app stays on the right side of provider terms; there is no credential store to leak.
- Clear, reviewable rule (CLAUDE.md hard rule 1; checked by the `reviewer` agent and evals).

### Negative

- Login state can't be shown before a session starts; the user discovers it in the terminal.
- Usage/limit information must come from hooks or CLI output only (Phase 6 usage panel).

## Revisit when

Never.

## References

- PLAN §1 non-goals, §5.6, §9 item 4, §11.1
- ADR 0019, 0020
