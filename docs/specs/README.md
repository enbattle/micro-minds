# Phase specs

One locked spec file per phase (`phase-N-<name>.md`), written from
`claude-code-agent-visualizer-plan.md`'s description of that phase and turned
into concrete, checkable criteria _before_ that phase's implementation
begins — see `CONTRIBUTING.md` for the full spec-lock → implement → review
workflow this supports. A phase's spec here is what a fresh test-writer
session works from; it shouldn't need anything from the implementer's own
reasoning to be understood.
