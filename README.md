# micro-minds

Building a town of models and agents working collaboratively.

micro-minds is a local, open-source tool that captures everything Claude
Code exposes about a multi-agent delegation session — a manager spawning
subagents, tool calls, permission requests, completions, failures — into a
structured, queryable, replayable event log. A minimal UI proves the data is
complete and useful; an interactive 2D scene, where each agent is a
character you can click into, comes later, gated on the earlier phases
actually working.

**Primary audience:** the author, using this daily against real Claude Code
work. **Secondary:** anyone who clones it. Both get the same care, since this
tool handles real source code and real prompts every day it runs — see
[`SECURITY.md`](SECURITY.md).

This is early — see
[`claude-code-agent-visualizer-plan.md`](claude-code-agent-visualizer-plan.md)
for the full phased build plan, [`docs/decisions/`](docs/decisions/) for why
key choices were made, and [`docs/specs/`](docs/specs/) for what's actually
locked in and being built right now.

## What this is not, on purpose

- Not a 3D game — see
  [`docs/decisions/0003-2d-not-3d-visualization.md`](docs/decisions/0003-2d-not-3d-visualization.md).
- Not published to npm — see
  [`docs/decisions/0004-github-clone-only-distribution.md`](docs/decisions/0004-github-clone-only-distribution.md).
- Not a network service — everything runs on `127.0.0.1`; see
  [`SECURITY.md`](SECURITY.md).

## Install

There is no npm package. Clone and link it locally:

```sh
git clone https://github.com/enbattle/micro-minds.git
cd micro-minds
npm install
npm link
```

Or run the CLI directly from the checked-out repo without linking:

```sh
npm run build
node dist/cli.js
```

## Status

Phase 0 — repository scaffolding. No capture logic exists yet; see the build
plan for what's next.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how work on this repo happens.

## License

MIT — see [`LICENSE`](LICENSE).
