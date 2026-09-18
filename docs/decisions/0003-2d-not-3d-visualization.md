# 0003 — 2D, not 3D, for the Phase 5 visualization layer

Status: Accepted

## Decision

Phase 5's interactive visualization renders each agent as a state-driven 2D
sprite or icon (Canvas, SVG, or DOM+CSS), laid out to reflect real
parent/child and task relationships. No 3D engine, no WebGL, no character
rigging or pathfinding.

## Alternatives considered

- **A 3D scene** (Three.js or similar), closer to the "cute characters
  walking around a game-like office" aesthetic that originally inspired this
  project.

## Why

The underlying data is discrete-state, not continuous: an agent's status
changes at lifecycle boundaries (idle → working → error/awaiting-input →
done), not smoothly over time. 3D's actual strengths — fluid motion, spatial
navigation, continuous animation — answer a question this data doesn't ask.
Building continuous-feeling motion on top of discrete events means faking
continuity, which is the same "decorative, not state-encoding" trap this
project otherwise deliberately avoids (every visual cue is supposed to trace
back to a real schema field).

2D also scales better for the actual use case: legibility drops in a 3D
scene well before it does in a 2D grid or hierarchy layout, and "see what
every agent is doing at a glance" is exactly the use case that degrades
first in 3D.

This isn't a permanent bet. Because the daemon is fully decoupled from
presentation (see the build plan's architecture principle 1), a 3D renderer
could be added later as just another consumer of the same event stream, if a
specific, named limitation of the 2D layer ever justifies it — not as a
default upgrade.
