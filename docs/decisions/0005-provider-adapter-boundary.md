# 0005 — Provider-adapter boundary, Claude Code only implemented for now

Status: Accepted

## Decision

Every event carries an explicit `provider` field (e.g. `"claude-code"`,
reserved for future values like `"gemini-cli"` or `"codex"`). A
`ProviderAdapter` contract —
`normalize(hookEventName: string, rawPayload: unknown): CanonicalEvent` — is
the interface any provider adapter must implement, and the boundary is
enforced by folder layout, not just convention:

```
/adapters/claude-code/   -- hook scripts + normalizer implementing ProviderAdapter
/adapters/<future>/      -- e.g. gemini-cli, added later, same interface
/schema/                 -- the JSON Schema, the actual contract
/daemon/                 -- provider-agnostic: only ever sees CanonicalEvent,
                          -- never imports anything from /adapters
```

Only the Claude Code adapter is implemented in this pass. No Gemini CLI or
Codex/GPT adapter is built now.

## Alternatives considered

- **No `provider` field, no adapter abstraction — build for Claude Code
  only, generalize later if needed.** Cheaper today, but principle 7 flags
  this as exactly the kind of choice that's cheap to get right now and
  expensive to retrofit: if the schema and daemon silently assume Claude
  Code is the only possible source, adding a second provider later means a
  schema redesign and a migration, not just writing a new adapter.
- **Build a Gemini CLI or Codex adapter now, alongside Claude Code's.**
  Rejected — those tools' hook/observability surfaces are unresearched and
  may not even support an equivalent capture mechanism. Building against an
  unverified surface would be guessing, which this project avoids even for
  Claude Code's own hooks (see the build plan's repeated "verify
  empirically" instruction).

## Why

The long-term intent is for agents backed by Claude Code, Gemini CLI, or
GPT-based coding agents to be interchangeable in this system. The cost of
keeping the seam clean now — a `provider` field, a real interface, a folder
boundary the daemon can't accidentally reach across — is small. The cost of
discovering later that Claude-Code-specific assumptions have calcified
through the schema and daemon code is not. Adding a second provider later
should mean writing a new adapter package against the existing contract, not
redesigning the system.
