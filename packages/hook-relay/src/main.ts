// Hook relay entry point, for CLIs without native HTTP hooks (PLAN §5.1). Claude uses native HTTP
// hooks (ADR 0029), so this stays a no-op until Phase 5 needs it. It already honors the relay's
// invariants (CLAUDE.md rule 5):
// it always exits 0 and never writes to stdout, so it can never change agent behavior.
process.exitCode = 0;
