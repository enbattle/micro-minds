# micro-minds

A local, open-source tool that captures Claude Code multi-agent sessions
(manager + subagents, tool calls, permission requests) into a structured,
replayable event log — schema and daemon first, visuals only much later, and
gated on the earlier phases actually working.

## Start here

- Full build plan, phase by phase:
  [`claude-code-agent-visualizer-plan.md`](claude-code-agent-visualizer-plan.md)
- The current phase's locked spec: [`docs/specs/`](docs/specs/)
- Why a non-obvious decision was made: [`docs/decisions/`](docs/decisions/)
- How work on this repo actually happens: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Before considering any task done

```
npm run typecheck && npm run lint && npm run format:check && npm run test:run && npm run build
```

These are the same commands CI runs — there should never be a gap between
what you self-check and what CI enforces.

## Easy to get wrong here specifically

- **Never assume a Claude Code hook payload's shape from documentation
  alone.** Instrument a real session and check `fixtures/`, or capture a
  fresh one, before trusting what a payload contains.
- **The daemon binds to `127.0.0.1` only.** Never `0.0.0.0`, never
  configurable to anything else. This tool's entire value depends on it.
- **Every request to the daemon needs the shared-secret token** from
  `~/.micro-minds/daemon.json` — localhost binding alone isn't
  authentication. See
  [`docs/decisions/0006-daemon-discovery-and-auth.md`](docs/decisions/0006-daemon-discovery-and-auth.md).
