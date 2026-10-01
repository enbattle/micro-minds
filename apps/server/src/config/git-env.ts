// The environment the server's own git commands run with (worktrees/git.ts). Only config modules
// read process.env. Inherited GIT_* variables are dropped: GIT_DIR, GIT_WORK_TREE or
// GIT_CONFIG_PARAMETERS set by whatever started the server would point git at another repo or
// re-enable what the hardening turns off.

/** The inherited environment without GIT_* variables, with credential prompts off. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('GIT_')) out[key] = value;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}
