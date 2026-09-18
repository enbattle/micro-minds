#!/usr/bin/env node

// Phase 0 scaffold: no real commands exist yet. See
// claude-code-agent-visualizer-plan.md for what this becomes.

const [, , command] = process.argv;

if (!command) {
  console.log('micro-minds: no command implemented yet (Phase 0 scaffold).');
  process.exit(0);
}

console.log(`micro-minds: command "${command}" is not implemented yet.`);
process.exit(1);
