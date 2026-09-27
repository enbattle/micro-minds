// Guard evals (PLAN §11.1): a deterministic table of tool calls, allowed and blocked, in POSIX,
// Git Bash, cmd and PowerShell forms, run against Windows, Linux and macOS contexts.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell and PowerShell `${VAR}` syntax is test data here.

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyPath,
  decide,
  expandHome,
  formatDenyOutput,
  type GuardContext,
  globToRegExp,
  isEnvFileName,
  parseToolCall,
  REASONS,
  splitSubcommands,
  tokenize,
} from '../../../.claude/hooks/guard.ts';

const WIN: GuardContext = {
  homeDir: 'C:\\Users\\alice',
  cwd: 'C:\\Users\\alice\\code\\micro-minds',
  platform: 'win32',
};
const LINUX: GuardContext = {
  homeDir: '/home/alice',
  cwd: '/home/alice/code/micro-minds',
  platform: 'linux',
};
const MAC: GuardContext = {
  homeDir: '/Users/alice',
  cwd: '/Users/alice/code/micro-minds',
  platform: 'darwin',
};

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const ps = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });
const file = (toolName: string, filePath: string) => ({
  tool_name: toolName,
  tool_input: { file_path: filePath },
});
const notebook = (notebookPath: string) => ({
  tool_name: 'NotebookEdit',
  tool_input: { notebook_path: notebookPath },
});
const grep = (input: Record<string, string>) => ({
  tool_name: 'Grep',
  tool_input: { pattern: 'TODO', ...input },
});
const glob = (input: Record<string, string>) => ({ tool_name: 'Glob', tool_input: input });

type Expected = 'allow' | keyof typeof REASONS;
type Case = readonly [label: string, ctx: GuardContext, input: unknown, expected: Expected];

const CASES: readonly Case[] = [
  // --- Home config dirs: POSIX shells ---------------------------------------------------------
  ['bash ~/.claude', LINUX, bash('cat ~/.claude/.credentials.json'), 'homeConfig'],
  ['bash ~/.gemini', LINUX, bash('ls ~/.gemini'), 'homeConfig'],
  ['bash ~/.codex', MAC, bash('cat ~/.codex/auth.json'), 'homeConfig'],
  ['bash $HOME', LINUX, bash('cat $HOME/.claude/settings.json'), 'homeConfig'],
  ['bash ${HOME}', LINUX, bash('cat ${HOME}/.gemini/oauth_creds.json'), 'homeConfig'],
  ['bash quoted "$HOME"/', LINUX, bash('cat "$HOME"/.claude/x'), 'homeConfig'],
  ['bash single-quoted path', LINUX, bash("head '/home/alice/.codex/config.toml'"), 'homeConfig'],
  ['bash absolute home', LINUX, bash('cat /home/alice/.claude/history.jsonl'), 'homeConfig'],
  ['bash relative ../..', LINUX, bash('cat ../../.claude/settings.json'), 'homeConfig'],
  ['bash cd ~ then relative', LINUX, bash('cd ~ && cat .claude/settings.json'), 'homeConfig'],
  ['bash glob ~/.c*', LINUX, bash('cat ~/.c*/auth.json'), 'homeConfig'],
  ['bash glob ~/.[cg]*', LINUX, bash('ls ~/.[cg]*'), 'homeConfig'],
  ['bash --flag=path', LINUX, bash('node x.js --config=~/.claude/settings.json'), 'homeConfig'],
  ['bash command substitution', LINUX, bash('echo $(cat ~/.codex/auth.json)'), 'homeConfig'],
  ['bash backticks', LINUX, bash('echo `cat ~/.claude/x`'), 'homeConfig'],
  ['bash input redirect', LINUX, bash('wc -l <~/.claude/history.jsonl'), 'homeConfig'],
  ['bash copy out', MAC, bash('cp -r ~/.claude /tmp/stolen'), 'homeConfig'],
  ['macOS upper case', MAC, bash('cat /users/ALICE/.CLAUDE/x'), 'homeConfig'],
  ['bash grep -r home', LINUX, bash('grep -r token ~'), 'homeRecursive'],
  ['bash find from /', LINUX, bash('find / -name auth.json'), 'homeRecursive'],
  ['bash rg in parent of parent', LINUX, bash('rg secret ../..'), 'homeRecursive'],

  // --- Home config dirs: Git Bash on Windows ---------------------------------------------------
  ['git bash ~/.claude', WIN, bash('cat ~/.claude/.credentials.json'), 'homeConfig'],
  ['git bash /c/Users', WIN, bash('cat /c/Users/alice/.claude/settings.json'), 'homeConfig'],
  ['git bash /C/users upper', WIN, bash('cat /C/users/ALICE/.Codex/auth.json'), 'homeConfig'],
  ['git bash $HOME', WIN, bash('ls $HOME/.gemini'), 'homeConfig'],
  ['git bash forward-slash C:', WIN, bash('cat C:/Users/alice/.claude/x'), 'homeConfig'],
  ['git bash /mnt/c', WIN, bash('cat /mnt/c/Users/alice/.claude/x'), 'homeConfig'],
  ['git bash glob user dir', WIN, bash('cat /c/Users/*/.claude/x'), 'homeConfig'],
  ['git bash relative', WIN, bash('cat ../../.claude/settings.json'), 'homeConfig'],

  // --- Home config dirs: cmd ---------------------------------------------------------------------
  ['cmd %USERPROFILE%', WIN, bash('type %USERPROFILE%\\.claude\\.credentials.json'), 'homeConfig'],
  ['cmd %HOMEDRIVE%%HOMEPATH%', WIN, bash('type %HOMEDRIVE%%HOMEPATH%\\.codex\\x'), 'homeConfig'],
  ['cmd /c type', WIN, bash('cmd /c "type %USERPROFILE%\\.gemini\\x"'), 'homeConfig'],
  ['cmd lower drive', WIN, bash('type c:\\users\\alice\\.claude\\x'), 'homeConfig'],

  // --- Home config dirs: PowerShell ------------------------------------------------------------
  ['ps $env:USERPROFILE', WIN, ps('Get-Content $env:USERPROFILE\\.claude\\x.json'), 'homeConfig'],
  ['ps $env:HOME', WIN, ps('gc $env:HOME/.codex/auth.json'), 'homeConfig'],
  ['ps ${env:USERPROFILE}', WIN, ps('cat "${env:USERPROFILE}\\.gemini\\x"'), 'homeConfig'],
  ['ps ~', WIN, ps('Get-ChildItem ~\\.claude'), 'homeConfig'],
  ['ps $HOME', WIN, ps('Get-Content "$HOME\\.claude\\settings.json"'), 'homeConfig'],
  ['ps absolute', WIN, ps('Get-Content C:\\Users\\alice\\.claude\\x'), 'homeConfig'],
  ['ps mixed case -Path', WIN, ps('Get-Content -Path C:\\USERS\\Alice\\.CLAUDE\\x'), 'homeConfig'],
  ['ps Join-Path', WIN, ps('Get-Content (Join-Path $HOME .claude)'), 'homeConfig'],
  ['ps Set-Location ~', WIN, ps('Set-Location ~; Get-Content .codex\\auth.json'), 'homeConfig'],
  ['ps backtick escape', WIN, ps('Get-Content ~\\.cl`aude\\x'), 'homeConfig'],
  ['ps Copy-Item', WIN, ps('Copy-Item -Recurse ~\\.claude C:\\tmp'), 'homeConfig'],
  ['ps recursive home', WIN, ps('Get-ChildItem -Recurse $env:USERPROFILE'), 'homeRecursive'],
  [
    'ps Select-String home',
    WIN,
    ps('Select-String -Path C:\\Users -Pattern x -r'),
    'homeRecursive',
  ],
  ['ps on linux ctx', LINUX, ps('Get-Content $HOME/.claude/x'), 'homeConfig'],

  // --- Home config dirs: file and search tools ---------------------------------------------------
  ['Read ~ path', LINUX, file('Read', '~/.claude/settings.json'), 'homeConfig'],
  ['Read absolute posix', MAC, file('Read', '/Users/alice/.codex/auth.json'), 'homeConfig'],
  [
    'Read absolute win',
    WIN,
    file('Read', 'C:\\Users\\alice\\.claude\\.credentials.json'),
    'homeConfig',
  ],
  ['Read win forward slashes', WIN, file('Read', 'c:/users/alice/.gemini/x'), 'homeConfig'],
  ['Read relative escape', WIN, file('Read', '..\\..\\.claude\\x'), 'homeConfig'],
  ['Edit home config', WIN, file('Edit', 'C:\\Users\\alice\\.claude\\settings.json'), 'homeConfig'],
  ['Write home config', LINUX, file('Write', '/home/alice/.claude/CLAUDE.md'), 'homeConfig'],
  ['MultiEdit home config', LINUX, file('MultiEdit', '/home/alice/.gemini/x'), 'homeConfig'],
  ['NotebookEdit home config', LINUX, notebook('/home/alice/.codex/n.ipynb'), 'homeConfig'],
  ['Grep home config', WIN, grep({ path: 'C:\\Users\\alice\\.claude' }), 'homeConfig'],
  ['Grep home', LINUX, grep({ path: '/home/alice' }), 'homeRecursive'],
  ['Grep filesystem root', WIN, grep({ path: 'C:\\' }), 'homeRecursive'],
  ['Glob home config pattern', LINUX, glob({ pattern: '/home/alice/.claude/**' }), 'homeConfig'],
  ['Glob ** from home', LINUX, glob({ pattern: '**/*.json', path: '~' }), 'homeRecursive'],
  ['Glob ** above home', WIN, glob({ pattern: 'C:/Users/**/auth.json' }), 'homeConfig'],
  ['payload cwd is used', LINUX, { ...bash('cat .claude/x'), cwd: '/home/alice' }, 'homeConfig'],

  // --- .env files --------------------------------------------------------------------------------
  ['bash cat .env', LINUX, bash('cat .env'), 'envFile'],
  ['bash cat .env.local', LINUX, bash('cat .env.local'), 'envFile'],
  ['bash nested .env', WIN, bash('cat apps/server/.env.production'), 'envFile'],
  ['bash source .env', LINUX, bash('source .env && npm run dev'), 'envFile'],
  ['bash dot .env', LINUX, bash('. ./.env'), 'envFile'],
  ['bash grep in .env', LINUX, bash('grep KEY .env'), 'envFile'],
  ['bash glob .env*', LINUX, bash('cat .env*'), 'envFile'],
  ['bash --env-file', LINUX, bash('node --env-file=.env server.ts'), 'envFile'],
  ['bash upper case', WIN, bash('cat .ENV'), 'envFile'],
  ['cmd type .env', WIN, bash('type .env'), 'envFile'],
  ['ps Get-Content .env', WIN, ps('Get-Content .\\.env'), 'envFile'],
  ['ps gc -Path .env.local', WIN, ps('gc -Path "apps\\server\\.env.local"'), 'envFile'],
  ['ps Select-String .env', WIN, ps('Select-String -Path .env -Pattern TOKEN'), 'envFile'],
  ['Read .env', WIN, file('Read', 'C:\\Users\\alice\\code\\micro-minds\\.env'), 'envFile'],
  ['Read .env.development', LINUX, file('Read', 'apps/server/.env.development'), 'envFile'],
  ['Edit .env', LINUX, file('Edit', '.env'), 'envFile'],
  ['Write .env.local', MAC, file('Write', '/Users/alice/code/micro-minds/.env.local'), 'envFile'],
  ['Grep path .env', LINUX, grep({ path: '.env' }), 'envFile'],
  ['Grep glob .env*', LINUX, grep({ glob: '.env*' }), 'envFile'],
  ['Glob **/.env', LINUX, glob({ pattern: '**/.env' }), 'envFile'],

  // --- Environment dumps -------------------------------------------------------------------------
  ['env', LINUX, bash('env'), 'envDump'],
  ['env piped', LINUX, bash('env | sort'), 'envDump'],
  ['env -0', LINUX, bash('env -0'), 'envDump'],
  ['printenv', LINUX, bash('printenv'), 'envDump'],
  ['set alone', LINUX, bash('set'), 'envDump'],
  ['set piped', WIN, bash('set | grep TOKEN'), 'envDump'],
  ['export -p', LINUX, bash('export -p'), 'envDump'],
  ['declare -x', LINUX, bash('declare -x'), 'envDump'],
  ['after && ', LINUX, bash('npm test && env'), 'envDump'],
  ['ps Get-ChildItem env:', WIN, ps('Get-ChildItem env:'), 'envDump'],
  ['ps gci Env:\\', WIN, ps('gci Env:\\'), 'envDump'],
  ['ps dir env:', WIN, ps('dir env:'), 'envDump'],
  ['ps ls -Path env:*', WIN, ps('ls -Path env:*'), 'envDump'],
  ['ps .NET dump', WIN, ps('[Environment]::GetEnvironmentVariables()'), 'envDump'],

  // --- Allowed -----------------------------------------------------------------------------------
  ['npm run check', WIN, bash('npm run check'), 'allow'],
  ['ps npm run check', WIN, ps('npm run check'), 'allow'],
  ['npm run env-check', LINUX, bash('npm run env-check'), 'allow'],
  ['git diff', LINUX, bash('git diff --stat'), 'allow'],
  ['cat source', LINUX, bash('cat src/index.ts'), 'allow'],
  ['set -e', LINUX, bash('set -e; npm test'), 'allow'],
  ['set -o pipefail', LINUX, bash('set -euo pipefail'), 'allow'],
  ['setx', WIN, bash('setx FOO bar'), 'allow'],
  ['env with command', LINUX, bash('env NODE_ENV=test npm test'), 'allow'],
  ['printenv one var', LINUX, bash('printenv NODE_ENV'), 'allow'],
  ['export assignment', LINUX, bash('export NODE_ENV=test'), 'allow'],
  ['ps one env var', WIN, ps('$env:NODE_ENV'), 'allow'],
  ['ps Get-Item env:PATH', WIN, ps('Get-Item env:PATH'), 'allow'],
  ['project .claude relative', LINUX, bash('cat .claude/settings.json'), 'allow'],
  ['project ./.claude agents', WIN, bash('cat ./.claude/agents/reviewer.md'), 'allow'],
  [
    'project .claude absolute',
    WIN,
    file('Read', 'C:\\Users\\alice\\code\\micro-minds\\.claude\\settings.json'),
    'allow',
  ],
  [
    'project .claude git bash',
    WIN,
    bash('cat /c/Users/alice/code/micro-minds/.claude/settings.json'),
    'allow',
  ],
  ['project .claude PowerShell', WIN, ps('Get-Content .\\.claude\\hooks\\guard.ts'), 'allow'],
  [
    'Edit project hook',
    MAC,
    file('Edit', '/Users/alice/code/micro-minds/.claude/hooks/guard.ts'),
    'allow',
  ],
  ['Grep project .claude', LINUX, grep({ path: '.claude' }), 'allow'],
  ['Glob project', WIN, glob({ pattern: '**/*.ts' }), 'allow'],
  ['Glob .claude inside project', LINUX, glob({ pattern: '.claude/**/*.md' }), 'allow'],
  ['other user .claude', LINUX, bash('cat /home/bob/.claude/x'), 'allow'],
  ['.claude-plugin dir', LINUX, bash('cat ~/.claude-plugin/x'), 'allow'],
  ['.env.example', LINUX, bash('cat .env.example'), 'allow'],
  ['.env.sample', WIN, ps('Get-Content .env.sample'), 'allow'],
  ['Read .env.template', LINUX, file('Read', 'apps/server/.env.template'), 'allow'],
  ['cp to .env.example.bak is blocked', LINUX, bash('cp .env.example .env.example.bak'), 'envFile'],
  ['.envrc is not .env', LINUX, bash('cat .envrc'), 'allow'],
  ['environment.ts', LINUX, file('Read', 'src/config/environment.ts'), 'allow'],
  ['grep for .env in text', LINUX, grep({ pattern: '\\.env', glob: '*.ts' }), 'allow'],
  ['rm -rf node_modules', LINUX, bash('rm -rf node_modules'), 'allow'],
  ['home subdir non-config', LINUX, bash('ls ~/code'), 'allow'],
  ['ls home, not recursive', LINUX, bash('ls ~'), 'allow'],
  ['grep -r in project', WIN, bash('grep -rn TODO .'), 'allow'],
  ['url with .claude', LINUX, bash('curl https://example.com/.claude/x'), 'allow'],
  ['unknown tool', LINUX, { tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, 'allow'],

  // --- Malformed input fails open ----------------------------------------------------------------
  ['null', LINUX, null, 'allow'],
  ['string', LINUX, 'cat ~/.claude/x', 'allow'],
  ['array', LINUX, [bash('env')], 'allow'],
  ['missing tool_input', LINUX, { tool_name: 'Bash' }, 'allow'],
  ['tool_input not object', LINUX, { tool_name: 'Bash', tool_input: 'env' }, 'allow'],
  ['missing tool_name', LINUX, { tool_input: { command: 'env' } }, 'allow'],
  ['command not string', LINUX, { tool_name: 'Bash', tool_input: { command: 42 } }, 'allow'],
  ['empty file_path', LINUX, file('Read', ''), 'allow'],

  // --- Claude Code working files under ~/.claude are exempt (plans, memory, tool-results) -------
  ['Read plan', LINUX, file('Read', '/home/alice/.claude/plans/plan-1.md'), 'allow'],
  ['Write plan (win)', WIN, file('Write', 'C:\\Users\\alice\\.claude\\plans\\p.md'), 'allow'],
  [
    'Read memory',
    MAC,
    file('Read', '/Users/alice/.claude/projects/-Users-alice-code/memory/MEMORY.md'),
    'allow',
  ],
  [
    'Write memory (win)',
    WIN,
    file('Write', 'C:\\Users\\alice\\.claude\\projects\\C--code\\memory\\fact.md'),
    'allow',
  ],
  [
    'Read tool-results',
    LINUX,
    file('Read', '/home/alice/.claude/projects/slug/tool-results/out-1.txt'),
    'allow',
  ],
  ['bash cat plan via ~', LINUX, bash('cat ~/.claude/plans/p.md'), 'allow'],
  // Everything else in ~/.claude stays blocked, including near misses and globs.
  [
    'credentials still blocked',
    LINUX,
    file('Read', '/home/alice/.claude/.credentials.json'),
    'homeConfig',
  ],
  [
    'settings still blocked',
    WIN,
    file('Read', 'C:\\Users\\alice\\.claude\\settings.json'),
    'homeConfig',
  ],
  [
    'session transcript blocked',
    LINUX,
    file('Read', '/home/alice/.claude/projects/slug/abc.jsonl'),
    'homeConfig',
  ],
  ['projects dir itself blocked', LINUX, bash('ls ~/.claude/projects'), 'homeConfig'],
  ['glob into projects blocked', LINUX, bash('cat ~/.claude/projects/*/memory/x'), 'homeConfig'],
  ['glob plans blocked', LINUX, bash('cat ~/.claude/pl*/x'), 'homeConfig'],
  ['.gemini plans not exempt', LINUX, file('Read', '/home/alice/.gemini/plans/p.md'), 'homeConfig'],
  [
    '.codex memory not exempt',
    LINUX,
    file('Read', '/home/alice/.codex/projects/s/memory/m'),
    'homeConfig',
  ],
];

describe('guard decide()', () => {
  it('has a large table', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CASES)('%s', (_label, ctx, input, expected) => {
    const decision = decide(input, ctx);
    if (expected === 'allow') {
      expect(decision).toEqual({ decision: 'allow' });
    } else {
      expect(decision).toEqual({ decision: 'deny', reason: REASONS[expected] });
    }
  });

  it('allows a repo .claude even when the repo sits directly in home', () => {
    const ctx: GuardContext = { ...LINUX, cwd: '/home/alice/.claude-repo' };
    expect(decide(bash('cat .claude/settings.json'), ctx)).toEqual({ decision: 'allow' });
    expect(decide(bash('cat ../.claude/settings.json'), ctx).decision).toBe('deny');
  });
});

describe('guard helpers', () => {
  it.each([
    ['.env', true],
    ['.env.local', true],
    ['.ENV.Production', true],
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],
    ['.env.example.local', true],
    ['.env*', true],
    ['.e?v', true],
    ['.*', true],
    ['*', false],
    ['*.ts', false],
    ['.envrc', false],
    ['env', false],
  ] as const)('isEnvFileName(%s) = %s', (name, expected) => {
    expect(isEnvFileName(name)).toBe(expected);
  });

  it.each([
    ['~/.claude', '/h/.claude'],
    ['$HOME', '/h'],
    ['${HOME}/x', '/h/x'],
    ['%USERPROFILE%\\x', '/h\\x'],
    ['$env:userprofile/x', '/h/x'],
    ['$HOMEPATH/x', '$HOMEPATH/x'],
    ['~bob/x', '~bob/x'],
  ] as const)('expandHome(%s)', (token, expected) => {
    expect(expandHome(token, '/h')).toBe(expected);
  });

  it('classifies paths against the home directory', () => {
    expect(classifyPath('C:\\Users\\alice\\.claude\\x', WIN)).toBe('home-config');
    expect(classifyPath('C:\\Users\\alice', WIN)).toBe('home-or-ancestor');
    expect(classifyPath('C:\\', WIN)).toBe('home-or-ancestor');
    expect(classifyPath('C:\\Users\\alice\\code', WIN)).toBe('other');
    expect(classifyPath('D:\\Users\\alice\\.claude', WIN)).toBe('other');
    expect(classifyPath('/home/ALICE/.claude', LINUX)).toBe('other');
  });

  it('converts globs segment-wise', () => {
    expect(globToRegExp('.c*').test('.claude')).toBe(true);
    expect(globToRegExp('[!.]*').test('.claude')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('[').test('[')).toBe(true);
  });

  it('splits commands and words', () => {
    expect(splitSubcommands('a && b || c; d | e & f\ng $(h) (i)')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
    ]);
    expect(tokenize(`cat "$HOME"/'.claude' --x=y <z`)).toEqual([
      'cat',
      '$HOME/.claude',
      '--x',
      'y',
      'z',
    ]);
  });

  it('parses only recognizable tool calls', () => {
    expect(parseToolCall({ tool_name: 'Read', tool_input: {}, cwd: '/x' })).toEqual({
      toolName: 'Read',
      toolInput: {},
      cwd: '/x',
    });
    expect(parseToolCall({ tool_name: '', tool_input: {} })).toBeNull();
  });
});

describe('guard.ts as a process (the Claude Code hook contract)', () => {
  const entry = fileURLToPath(new URL('../../../.claude/hooks/guard.ts', import.meta.url));
  const run = (stdin: string) =>
    spawnSync(process.execPath, [entry], { input: stdin, encoding: 'utf8', timeout: 10_000 });

  it('denies with decision JSON on stdout, the reason on stderr and exit code 2', () => {
    const target = path.join(os.homedir(), '.claude', 'settings.json');
    const result = run(JSON.stringify(file('Read', target)));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe(`${formatDenyOutput(REASONS.homeConfig)}\n`);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REASONS.homeConfig,
      },
    });
    expect(result.stderr).toBe(`${REASONS.homeConfig}\n`);
  });

  it('allows silently on a normal command', () => {
    const result = run(JSON.stringify(bash('npm run check')));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('fails open on malformed stdin, with a note on stderr only', () => {
    const result = run('{not json');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^micro-minds guard: .+; allowing\n$/);
  });
});
