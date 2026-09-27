# 0014. `raw` payloads are bounded and redacted

- Status: Accepted
- Date: 2026-09-26
- Plan: D14 (PLAN §2)

## Context

Hook payloads can contain full file contents, for example a `tool_response` after the agent
reads `.env`. Keeping raw payloads helps debugging and handling `unknown` events, but storing
or broadcasting them verbatim would leak secrets into SQLite and every browser tab.

## Decision

`AgentEvent.raw` is truncated to a size cap and passed through the scrubber (API-key
patterns, bearer tokens, `KEY=value` lines from env-like content, high-entropy strings)
before storage. It's kept in full only for `unknown` events or in debug mode. `tool.summary`
and `text` are scrubbed too. `raw` is stripped from WS `event` frames unless the client
explicitly asks for it (PLAN §8, §9 item 5). The scrubber has its own corpus of secret shapes
and negatives (task 2.2).

## Consequences

### Positive

- Sensitive data at rest and on the wire is minimized.
- The false-negative/false-positive balance of the scrubber is tested, not guessed.

### Negative

- Debugging sometimes lacks the full payload; debug mode is the escape hatch.
- Scrubbing is heuristic: it can miss novel secret shapes or over-redact useful text.
- Scrubbing and capping cost CPU on every event.

## Revisit when

No trigger planned.

## References

- PLAN §4.1, §8, §9 item 5, §11, §12
- CLAUDE.md hard rule 8
