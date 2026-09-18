# Contributing

This is primarily a personal project used daily against real Claude Code
work, but it's public and anyone can clone it. Either way, the workflow
below is how work on this repo actually happens — written down once so it
doesn't quietly drift session to session, and so it's clear if anyone else
ever sends a change.

The domain this project works in — real captured source code and prompts,
and a mechanism (Phase 3) explicitly designed to block a running agent — is
sensitive enough to warrant more process than "write code, glance at it,
move on." Concretely:

## 1. Spec, locked before implementation

Each phase's section in
[`claude-code-agent-visualizer-plan.md`](claude-code-agent-visualizer-plan.md)
is the starting spec. Before implementation starts on a phase, its
Definition of Done gets turned into concrete, checkable test cases — written
and committed, confirmed to fail for the right reason, before any
implementation code exists. Implementation is not allowed to weaken or edit
these tests to make them pass; if a locked test looks wrong once
implementation is underway, that's a spec problem — escalate it and fix the
spec, don't quietly patch the test. The locked spec itself lives in
[`docs/specs/`](docs/specs/), one file per phase.

## 2. Separate roles, run in fresh sessions

A test-writer session writes the phase's tests from the spec alone, with no
visibility into how it'll be implemented. A separate implementer session
writes the phase's code against the locked tests and never edits them. A
separate reviewer session — fresh context, given only the diff, the spec,
and the tests, never the implementer's own reasoning — reviews
adversarially: its job is to construct failure cases, not confirm the diff
looks reasonable. The `/code-review` skill run in a fresh context is the
concrete mechanism for this reviewer role.

## 3. Cap rejection rounds, then escalate to a human

Two rejection rounds from the reviewer on the same phase, then stop and
bring it to a human rather than continuing to loop the implementer against
reviewer feedback indefinitely.

## 4. Every loop needs a budget and an exit

This applies to the system's own runtime behavior, not just this review
process — e.g. Phase 3's answer-polling loop has a hard maximum wait and an
explicit, logged escalation path on timeout, never a silent retry-forever.

## 5. Artifacts carry state, not conversations

Anything a later role or session needs — the spec, the locked tests, the
diff, review findings — is a file in the repo, not something only visible in
a prior chat transcript. This is what makes genuinely fresh-context roles
possible at all.

## 6. Every review nominates at least one removal

A workspace that only accretes files, principles, and code is decaying in
slow motion even while every individual change looks fine. Each review
should name at least one thing that could be simplified or deleted —
including in the plan document itself, once implementation reveals a step
was unnecessary.

## Recording decisions

Any genuinely non-obvious choice gets a short architecture decision record
in [`docs/decisions/`](docs/decisions/) — see that directory's own README
for the format and status convention.
