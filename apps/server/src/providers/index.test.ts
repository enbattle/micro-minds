// Task 2.4, clause D10: the default registry holds the Claude and fake adapters, in that order.
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude/adapter.ts';
import { fakeAdapter } from './fake/adapter.ts';
import { createDefaultRegistry } from './index.ts';

describe('createDefaultRegistry (D10)', () => {
  it('lists claude then fake', () => {
    const registry = createDefaultRegistry();
    expect(registry.list().map((a) => a.id)).toEqual(['claude', 'fake']);
    expect(registry.list()[0]).toBe(claudeAdapter);
    expect(registry.list()[1]).toBe(fakeAdapter);
  });

  it('looks both adapters up by id, and nothing else', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('claude')).toBe(claudeAdapter);
    expect(registry.get('fake')).toBe(fakeAdapter);
    expect(registry.get('gemini')).toBeUndefined();
    expect(registry.get('codex')).toBeUndefined();
  });

  it('categorizes through the adapters', () => {
    const registry = createDefaultRegistry();
    expect(registry.categorize('claude', 'Grep')).toBe('read');
    expect(registry.categorize('claude', 'mcp__x__y')).toBe('other');
    expect(registry.categorize('fake', 'Agent')).toBe('delegate');
  });
});
