// Hook relay entry point. Until Phase 1 decides whether a relay is needed at all (PLAN §5.1),
// this is a no-op that already honors the relay's invariants (CLAUDE.md rule 5):
// it always exits 0 and never writes to stdout, so it can never change agent behavior.
process.exitCode = 0;
