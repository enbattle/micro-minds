# 0002 — SQLite for queries, independent append-only JSONL as a durability backstop

Status: Accepted

## Decision

Every normalized event is written to two places on every ingest: a SQLite
database (`better-sqlite3`, embedded, zero setup) for querying and replay,
and a raw append-only JSONL file per session, independent of the database.
Full-fidelity data in both stores is the permanent source of truth — there
is no summary-only mode. A separate, cheap, non-LLM per-session summary
record exists purely as a fast index for browsing history; it never replaces
the underlying full event log it's derived from. Storage has a lifecycle
(`prune`/`gc`, and a "pin" action to exempt a specific session), but pruning
is opt-in per session, not automatic-and-silent.

## Alternatives considered

- **SQLite only, no JSONL backstop.** Simpler, but a crash or corruption
  during a write leaves no independent copy to recover from — for a tool
  whose entire value is a faithful, replayable record of what happened,
  that single point of failure isn't acceptable.
- **A heavier embedded or client-server database.** Unnecessary complexity
  for a single-user, single-machine tool, and a client-server option would
  either violate the localhost-only principle or add an install dependency
  this project deliberately avoids (zero setup for end users).
- **Summary-only storage, dropping full transcripts after some time.**
  Rejected — this would quietly break the tool's actual value proposition
  (faithful replay), not just trim convenience. See "why," below.

## Why

Two stores exist because they fail independently: SQLite is what makes the
data queryable (`GET /sessions`, filtering, joins across events), while the
JSONL file is a dumb, append-only log that's much harder to corrupt and easy
to replay from scratch if the database is ever lost or needs to be rebuilt.

Full fidelity stays the default specifically because "replay what actually
happened, completely and in the correct order" is the project's overall
success criterion — a summary-only design would trade away the actual
deliverable for storage convenience. The lifecycle problem (both stores grow
unbounded with real, sensitive data) is solved separately, via retention and
pinning, rather than by weakening what gets captured in the first place.
