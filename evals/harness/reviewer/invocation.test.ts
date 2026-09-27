import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildPrompt, DEFAULT_INVOCATION, formatCommand } from './invocation.ts';

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs(DEFAULT_INVOCATION);

  it('runs the reviewer agent headlessly with JSON output', () => {
    expect(args[0]).toBe('-p');
    expect(flagValue(args, '--agent')).toBe('reviewer');
    expect(flagValue(args, '--output-format')).toBe('json');
  });

  it('is read-only and bounded', () => {
    expect(flagValue(args, '--permission-mode')).toBe('dontAsk');
    expect(flagValue(args, '--tools')).toBe('Read,Grep,Glob');
    expect(flagValue(args, '--max-turns')).toBe(String(DEFAULT_INVOCATION.maxTurns));
    expect(flagValue(args, '--max-budget-usd')).toBe(String(DEFAULT_INVOCATION.maxBudgetUsd));
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('never passes the prompt or diff on the command line', () => {
    expect(args.every((arg) => !arg.includes(' ') && !arg.includes('\n'))).toBe(true);
  });

  it('adds a model override only when given', () => {
    expect(flagValue(args, '--model')).toBeUndefined();
    const withModel = buildClaudeArgs({ ...DEFAULT_INVOCATION, model: 'claude-opus-5-5' });
    expect(flagValue(withModel, '--model')).toBe('claude-opus-5-5');
  });

  it.each(['opus && calc', 'a b', '"x"', 'm|n'])('refuses shell-unsafe model %j', (model) => {
    expect(() => buildClaudeArgs({ ...DEFAULT_INVOCATION, model })).toThrow('unsafe');
  });
});

describe('buildPrompt', () => {
  it('wraps the diff in a fence after the instructions', () => {
    const prompt = buildPrompt('diff --git a/x b/x\n+++ b/x\n');
    expect(prompt).toContain('may not exist on disk');
    expect(prompt).toContain('````diff\ndiff --git a/x b/x\n+++ b/x\n````');
  });

  it('uses a longer fence when the diff contains a four-backtick fence', () => {
    const prompt = buildPrompt('+````md\n');
    expect(prompt).toContain('``````diff\n+````md\n``````');
  });
});

describe('formatCommand', () => {
  it('quotes only arguments that need it', () => {
    expect(formatCommand('C:\\Program Files\\claude.exe', ['-p', '--agent', 'reviewer'])).toBe(
      '"C:\\Program Files\\claude.exe" -p --agent reviewer',
    );
  });
});
