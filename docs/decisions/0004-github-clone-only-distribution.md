# 0004 — GitHub-clone-only distribution, no npm publish

Status: Accepted

## Decision

The only supported install path for now is `git clone` → `npm install` →
`npm link` (or running the CLI directly from the checked-out repo). No npm
registry account, no `npm publish`, no public package listing. The `package.json`
is still structured as a normal npm-installable package from the start (a
proper `bin` field, no assumptions about being run from a specific relative
path) so that publishing later, if it ever happens, is a registry action, not
an engineering rewrite.

## Alternatives considered

- **Publish to npm now**, enabling `npx micro-minds` for anyone.

## Why

Publishing itself is cheap; everything after it isn't. Once a package is on
the public registry, it implicitly commits to semver discipline, handling
issues from strangers running it against Claude Code versions it wasn't
tested against, and keeping a public listing that doesn't misrepresent what
the tool does — real maintenance overhead for a project that, as of this
decision, doesn't have a working daemon yet.

The stated primary audience for this tool is daily personal use; the
secondary audience (anyone who clones it off GitHub) doesn't need a
one-line install to get real value. Revisit npm publishing only after Phase
4 (or 5) is validated and there's an actual person other than the author who
wants a one-line install — a distribution decision made after the tool
works, not a build-order decision now.
