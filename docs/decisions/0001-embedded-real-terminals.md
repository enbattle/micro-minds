# 0001. Embedded real terminals for prompting

- Status: Accepted
- Date: 2026-09-26
- Plan: D1 (PLAN §2)

## Context

Users need to prompt each agent from inside micro-minds. Options were a custom chat UI
(driving the CLI through a structured API such as the Agent SDK or stream-json) or the real
CLI running in a terminal. A chat UI means re-implementing permission prompts, slash
commands, TUI features and every future CLI change. Subscription use is also safest when the
official CLI runs interactively on the user's own machine.

## Decision

Each session is the real provider CLI running in a PTY on the server (`node-pty`, ConPTY on
Windows) and rendered in the browser with xterm.js (`@xterm/xterm` + `@xterm/addon-fit`) in the
terminal drawer. Keystrokes go over the WebSocket as `pty.input`; output comes back as batched
`pty.data` frames (PLAN §8).

## Consequences

### Positive

- Full CLI behavior (permissions, slash commands, alt-screen TUIs) with no chat UI to build.
- Nothing is lost versus using the CLI directly; new CLI features work immediately.
- Keeps the app on the most stable footing for subscription terms (see ADR 0004).

### Negative

- Terminal output cannot be parsed reliably, so structured state needs a second channel
  (hooks, ADR 0002).
- Native dependency (`node-pty`) with per-OS install concerns (ADR 0011).
- Reconnect repaint needs server-side terminal state (ADR 0016).

## Revisit when

Phase 7 (optional structured chat mode). Re-check provider terms before starting it.

## References

- PLAN §1, §5.5, §7, §8
- ADR 0002, 0004, 0011, 0016
