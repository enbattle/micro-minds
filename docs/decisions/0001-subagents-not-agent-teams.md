# 0001 — Capture the subagent (hub-and-spoke) model, not agent-teams

Status: Accepted

## Decision

This project captures and models Claude Code's subagent delegation pattern:
a manager session spawns subagents via the Task tool, each subagent works in
isolation, and results report back to the manager. It does not attempt to
capture Claude Code's experimental agent-teams feature, where teammates
message each other directly as peers.

## Alternatives considered

- **Agent-teams (peer-to-peer messaging).** This is the feature that would
  support two agents iterating with each other directly before a manager
  ever sees the result — closer to the "two characters converse before
  escalating to a human" behavior that partly inspired this project.
- **Both, from the start.** Rejected as unnecessary scope for a first pass —
  see "why," below.

## Why

Two independent reasons converge on the same answer:

1. **It's unverified how observable agent-teams even is.** It's
   experimental, disabled by default, and it's unknown how much of direct
   teammate-to-teammate messaging is exposed through hooks in a structured
   way versus buried in each teammate's own transcript. Building a capture
   model around an unresearched surface would be guessing.
2. **It doesn't match the actual workflow this tool is built for.** Real
   usage is a pipeline — manager delegates, a worker does the work, the
   manager collects the result, and iteration (when needed) happens as the
   manager re-delegating with feedback, not as two agents negotiating
   directly. That "retry-with-feedback" pattern is still hub-and-spoke; it
   gets the practical benefit of iteration without needing peer messaging or
   shared live context between subagents.

Agent-teams capture stays a named, deliberately deferred practice (see the
build plan's "Deferred practices" section) rather than a closed door — it's
revisited if a real workflow actually needs agents to iterate with each
other before a manager sees the result, or once Claude Code's agent-teams
observability surface stabilizes.
