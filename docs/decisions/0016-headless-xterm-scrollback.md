# 0016. Terminal scrollback is kept by a headless xterm on the server

- Status: Accepted
- Date: 2026-09-26
- Plan: D16 (PLAN §2)

## Context

Browser tabs close and reconnect while agents keep running, and several tabs can view one
session. A reconnecting client must see the current screen. Replaying a buffer of raw PTY
bytes breaks on partial escape sequences, and alt-screen TUIs (like the Claude Code UI) end
up garbled.

## Decision

The server keeps one `@xterm/headless` terminal per session, fed with all PTY output. On
(re)connect it sends a `pty.snapshot` frame produced by `@xterm/addon-serialize`, then live
`pty.data` frames (PLAN §8). Its size follows the PTY, which follows the most recently focused
tab (PLAN §5.6).

## Consequences

### Positive

- Correct repaint of the screen and scrollback, including alt-screen state.
- Closing the browser never affects agents.

### Negative

- Server memory and CPU per session for terminal emulation and scrollback.
- Serialization fidelity is bounded by what the serialize addon supports.

## Revisit when

No trigger planned.

## References

- PLAN §3, §5.5, §5.6, §8, task 2.6, task 3.3
- ADR 0001
