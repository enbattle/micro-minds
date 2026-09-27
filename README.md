# micro-minds

Building a town of models and agents working collaboratively.

> Early development. The MVP scope and roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Development

Requires Node 24.2 or newer.

```sh
npm install
npm run check   # lint, typecheck, test
```

- [docs/PLAN.md](docs/PLAN.md): scope, architecture and phases (the source of truth)
- [docs/decisions/](docs/decisions/): architecture decision records
- [docs/dev-harness.md](docs/dev-harness.md): the Claude Code harness for this repo (permissions,
  guard hook and its `~/.claude` exemption, agents, skills, evals)
- [CLAUDE.md](CLAUDE.md): rules for AI agents working in this repo
