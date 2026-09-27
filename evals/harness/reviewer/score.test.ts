import { describe, expect, it } from 'vitest';
import {
  type CaseScore,
  casePassed,
  checkUnifiedDiff,
  type Expected,
  extractFinalJsonBlock,
  extractRuleCatalog,
  type Finding,
  formatSummaryTable,
  parseClaudeJson,
  parseExpected,
  parseReviewOutput,
  RECALL_THRESHOLD,
  type ReviewOutput,
  scoreCase,
  scoreErroredCase,
  summarize,
} from './score.ts';

const CATALOG = [
  'HR3-localhost-bind',
  'HR8-raw-leak',
  'CONV-any',
  'CONV-erasable-syntax',
  'GEN-correctness',
];

function finding(ruleId: string, severity: Finding['severity'] = 'blocker'): Finding {
  return { ruleId, severity, file: 'apps/server/src/http/listen.ts', line: 14, summary: 's' };
}

function review(findings: Finding[]): ReviewOutput {
  const blocking = findings.some((f) => f.severity !== 'minor');
  return { findings, verdict: blocking ? 'changes_requested' : 'approve' };
}

function expected(mustFind: string[], mustNotFind: string[] = []): Expected {
  return { mustFind, mustNotFind, notes: 'n' };
}

function fenced(json: string): string {
  return `\`\`\`json\n${json}\n\`\`\``;
}

describe('extractRuleCatalog', () => {
  it('collects ids from catalog table rows only, once each', () => {
    const md = [
      '| ID | Rule |',
      '|---|---|',
      '| `HR3-localhost-bind` | Bind to 127.0.0.1 |',
      '|  `CONV-any`  | No any |',
      '| `CONV-any` | duplicate |',
      'Prose mentioning `HR8-raw-leak` is not a row.',
      '### [blocker] HR3-localhost-bind — heading, not a row',
    ].join('\n');
    expect(extractRuleCatalog(md)).toEqual(['HR3-localhost-bind', 'CONV-any']);
  });
});

describe('extractFinalJsonBlock', () => {
  it.each([
    { name: 'no block', text: 'All good.', expected: undefined },
    { name: 'single block', text: `x\n${fenced('{"a":1}')}\n`, expected: '{"a":1}' },
    {
      name: 'last block wins',
      text: `${fenced('{"example":true}')}\nmore\n${fenced('{"final":true}')}`,
      expected: '{"final":true}',
    },
    { name: 'CRLF line endings', text: '```json\r\n{"a":1}\r\n```\r\n', expected: '{"a":1}' },
    { name: 'ignores non-json fences', text: '```ts\nconst a = 1;\n```', expected: undefined },
  ])('$name', ({ text, expected }) => {
    expect(extractFinalJsonBlock(text)).toBe(expected);
  });
});

describe('parseReviewOutput', () => {
  const valid = {
    findings: [
      {
        ruleId: ' HR3-localhost-bind ',
        severity: 'blocker',
        file: 'apps/server/src/http/listen.ts',
        line: 14,
        summary: 'Binds 0.0.0.0',
      },
      { ruleId: 'TEST-missing', severity: 'major', file: 'x.ts', line: null, summary: 'No test' },
    ],
    verdict: 'changes_requested',
  };

  it('parses a valid block and trims rule ids', () => {
    const result = parseReviewOutput(`## Summary\n…\n${fenced(JSON.stringify(valid))}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('changes_requested');
    expect(result.value.findings.map((f) => f.ruleId)).toEqual([
      'HR3-localhost-bind',
      'TEST-missing',
    ]);
  });

  it('accepts a clean review with no findings', () => {
    const result = parseReviewOutput(fenced('{"findings":[],"verdict":"approve"}'));
    expect(result).toEqual({ ok: true, value: { findings: [], verdict: 'approve' } });
  });

  it.each([
    { name: 'missing block', text: 'No findings.', error: 'no ```json block' },
    { name: 'invalid JSON', text: fenced('{"findings":[],}'), error: 'not valid JSON' },
    { name: 'array root', text: fenced('[]'), error: 'not an object' },
    {
      name: 'findings not array',
      text: fenced('{"findings":{},"verdict":"approve"}'),
      error: '"findings"',
    },
    { name: 'bad verdict', text: fenced('{"findings":[],"verdict":"lgtm"}'), error: '"verdict"' },
    {
      name: 'bad severity',
      text: fenced(
        '{"findings":[{"ruleId":"CONV-any","severity":"critical","file":"a","line":1,"summary":"s"}],"verdict":"approve"}',
      ),
      error: 'findings[0].severity',
    },
    {
      name: 'fractional line',
      text: fenced(
        '{"findings":[{"ruleId":"CONV-any","severity":"minor","file":"a","line":1.5,"summary":"s"}],"verdict":"approve"}',
      ),
      error: 'findings[0].line',
    },
    {
      name: 'empty rule id',
      text: fenced(
        '{"findings":[{"ruleId":" ","severity":"minor","file":"a","line":1,"summary":"s"}],"verdict":"approve"}',
      ),
      error: 'findings[0].ruleId',
    },
  ])('rejects $name', ({ text, error }) => {
    const result = parseReviewOutput(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(error);
  });
});

describe('parseClaudeJson', () => {
  it('reads the fields of a successful result message', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'review text',
      total_cost_usd: 0.1234,
      num_turns: 3,
      session_id: 'ignored',
    });
    expect(parseClaudeJson(`${stdout}\n`)).toEqual({
      ok: true,
      value: {
        resultText: 'review text',
        isError: false,
        subtype: 'success',
        costUsd: 0.1234,
        numTurns: 3,
        models: [],
      },
    });
  });

  it.each([
    { name: 'max turns', data: { type: 'result', subtype: 'error_max_turns', is_error: false } },
    { name: 'is_error flag', data: { type: 'result', subtype: 'success', is_error: true } },
  ])('marks $name as an error', ({ data }) => {
    const result = parseClaudeJson(JSON.stringify(data));
    expect(result.ok && result.value.isError).toBe(true);
  });

  it.each([
    { name: 'plain text', stdout: 'Error: not logged in' },
    { name: 'non-result message', stdout: '{"type":"system"}' },
  ])('rejects $name', ({ stdout }) => {
    expect(parseClaudeJson(stdout).ok).toBe(false);
  });
});

describe('parseExpected', () => {
  it('accepts known ids', () => {
    const value = { mustFind: ['HR3-localhost-bind'], mustNotFind: ['CONV-any'], notes: 'n' };
    expect(parseExpected(value, CATALOG)).toEqual({ ok: true, value });
  });

  it.each([
    { name: 'not an object', value: [], error: 'must be an object' },
    { name: 'missing mustFind', value: { mustNotFind: [], notes: 'n' }, error: '"mustFind"' },
    { name: 'empty notes', value: { mustFind: [], mustNotFind: [], notes: ' ' }, error: '"notes"' },
    {
      name: 'malformed id',
      value: { mustFind: ['hr3 bind'], mustNotFind: [], notes: 'n' },
      error: 'malformed rule id',
    },
    {
      name: 'id outside the catalog',
      value: { mustFind: ['HR99-made-up'], mustNotFind: [], notes: 'n' },
      error: 'not in the reviewer catalog',
    },
    {
      name: 'id in both lists',
      value: { mustFind: ['CONV-any'], mustNotFind: ['CONV-any'], notes: 'n' },
      error: 'in both mustFind and mustNotFind',
    },
  ])('rejects $name', ({ value, error }) => {
    const result = parseExpected(value, CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(error);
  });
});

describe('checkUnifiedDiff', () => {
  it('lists the new-side file paths', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- /dev/null',
      '+++ b/apps/server/src/x.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    ].join('\n');
    expect(checkUnifiedDiff(diff)).toEqual({
      ok: true,
      value: { files: ['apps/server/src/x.ts'] },
    });
  });

  it.each([
    { name: 'no file header', diff: '@@ -1 +1 @@\n-a\n+b', error: 'file headers' },
    { name: 'no hunk header', diff: '--- a/x\n+++ b/x\n-a\n+b', error: 'hunk headers' },
  ])('rejects $name', ({ diff, error }) => {
    const result = checkUnifiedDiff(diff);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(error);
  });
});

describe('scoreCase', () => {
  it('counts found and missed planted rules, case-insensitively', () => {
    const score = scoreCase(
      'two-planted',
      expected(['CONV-any', 'CONV-erasable-syntax']),
      review([finding('conv-any', 'major')]),
      CATALOG,
    );
    expect(score).toMatchObject({
      clean: false,
      status: 'scored',
      found: ['CONV-any'],
      missed: ['CONV-erasable-syntax'],
      forbiddenHits: [],
      falsePositives: [],
      verdictAsExpected: true,
    });
  });

  it('reports mustNotFind hits at any severity', () => {
    const score = scoreCase(
      'bind',
      expected(['HR3-localhost-bind'], ['HR8-raw-leak']),
      review([finding('HR3-localhost-bind'), finding('HR8-raw-leak', 'minor')]),
      CATALOG,
    );
    expect(score.found).toEqual(['HR3-localhost-bind']);
    expect(score.forbiddenHits).toEqual(['HR8-raw-leak']);
  });

  it.each([
    { name: 'no findings', findings: [], falsePositives: 0, verdictOk: true },
    {
      name: 'minor only',
      findings: [finding('GEN-correctness', 'minor')],
      falsePositives: 0,
      verdictOk: true,
    },
    {
      name: 'a major',
      findings: [finding('GEN-correctness', 'major')],
      falsePositives: 1,
      verdictOk: false,
    },
    {
      name: 'blocker and minor',
      findings: [finding('HR8-raw-leak', 'blocker'), finding('CONV-any', 'minor')],
      falsePositives: 1,
      verdictOk: false,
    },
  ])('clean case with $name', ({ findings, falsePositives, verdictOk }) => {
    const score = scoreCase('clean', expected([]), review(findings), CATALOG);
    expect(score.clean).toBe(true);
    expect(score.falsePositives).toHaveLength(falsePositives);
    expect(score.verdictAsExpected).toBe(verdictOk);
  });

  it('flags rule ids outside the catalog once', () => {
    const score = scoreCase(
      'bind',
      expected(['HR3-localhost-bind']),
      review([finding('HR3-localhost-bind'), finding('SEC-made-up'), finding('SEC-made-up')]),
      CATALOG,
    );
    expect(score.unknownRuleIds).toEqual(['SEC-made-up']);
  });

  it('marks an errored case as missing everything', () => {
    const score = scoreErroredCase('bind', expected(['HR3-localhost-bind']), 'timed out');
    expect(score).toMatchObject({
      status: 'error',
      error: 'timed out',
      missed: ['HR3-localhost-bind'],
    });
  });
});

describe('parseClaudeJson models', () => {
  it('reads model ids from modelUsage', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'r',
      modelUsage: { 'claude-opus-5-5': { costUSD: 0.2 } },
    });
    const result = parseClaudeJson(stdout);
    expect(result.ok && result.value.models).toEqual(['claude-opus-5-5']);
  });
});

describe('casePassed', () => {
  it.each([
    {
      name: 'all found',
      score: scoreCase('a', expected(['CONV-any']), review([finding('CONV-any')]), CATALOG),
      passed: true,
    },
    {
      name: 'a miss',
      score: scoreCase('a', expected(['CONV-any']), review([]), CATALOG),
      passed: false,
    },
    {
      name: 'a forbidden hit',
      score: scoreCase(
        'a',
        expected(['CONV-any'], ['HR8-raw-leak']),
        review([finding('CONV-any'), finding('HR8-raw-leak', 'minor')]),
        CATALOG,
      ),
      passed: false,
    },
    {
      name: 'a clean-case false positive',
      score: scoreCase('c', expected([]), review([finding('GEN-correctness', 'major')]), CATALOG),
      passed: false,
    },
    {
      name: 'an error on a clean case',
      score: scoreErroredCase('c', expected([]), 'boom'),
      passed: false,
    },
  ])('$name -> $passed', ({ score, passed }) => {
    expect(casePassed(score)).toBe(passed);
  });
});

describe('summarize', () => {
  const planted = (name: string, found: number, total: number): CaseScore => {
    const ids = CATALOG.slice(0, total);
    return scoreCase(
      name,
      expected(ids),
      review(ids.slice(0, found).map((id) => finding(id))),
      CATALOG,
    );
  };

  it('passes at or above the recall threshold with clean cases clean', () => {
    const scores = [
      planted('a', 2, 2),
      planted('b', 2, 3),
      planted('c', 4, 5),
      scoreCase('clean', expected([]), review([]), CATALOG),
    ];
    const summary = summarize(scores);
    expect(summary).toMatchObject({
      mustFindTotal: 10,
      mustFindFound: 8,
      passed: true,
      reasons: [],
    });
    expect(summary.recall).toBeCloseTo(0.8);
    expect(summary.threshold).toBe(RECALL_THRESHOLD);
  });

  it('fails below the threshold', () => {
    const summary = summarize([planted('a', 1, 2)]);
    expect(summary.passed).toBe(false);
    expect(summary.reasons.join()).toContain('below the 80% threshold');
  });

  it('fails on a clean-case false positive even with perfect recall', () => {
    const summary = summarize([
      planted('a', 2, 2),
      scoreCase('clean', expected([]), review([finding('GEN-correctness', 'major')]), CATALOG),
    ]);
    expect(summary.recall).toBe(1);
    expect(summary.cleanCasesWithFalsePositives).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it('fails on forbidden hits and errors', () => {
    const forbidden = scoreCase(
      'f',
      expected(['HR3-localhost-bind'], ['CONV-any']),
      review([finding('HR3-localhost-bind'), finding('CONV-any', 'minor')]),
      CATALOG,
    );
    const errored = scoreErroredCase('e', expected(['CONV-any']), 'boom');
    const summary = summarize([forbidden, errored]);
    expect(summary).toMatchObject({ forbiddenHits: 1, errors: 1, passed: false });
    expect(summary.reasons).toHaveLength(3);
  });

  it('treats a run with no planted rules as full recall', () => {
    expect(summarize([]).recall).toBe(1);
  });
});

describe('formatSummaryTable', () => {
  it('renders one aligned row per case and a totals line', () => {
    const scores = [
      scoreCase(
        'bind',
        expected(['HR3-localhost-bind']),
        review([finding('HR3-localhost-bind')]),
        CATALOG,
      ),
      scoreCase('clean', expected([]), review([finding('GEN-correctness', 'major')]), CATALOG),
      scoreErroredCase('broken', expected(['CONV-any']), 'timed out'),
    ];
    const table = formatSummaryTable(scores, summarize(scores));
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^case\s+type\s+found\s+missed/);
    expect(lines[2]).toMatch(/^bind\s+planted\s+1\/1\s+-\s+-\s+-\s+changes_requested\s+PASS$/);
    expect(lines[3]).toMatch(/^clean\s+clean\s+-\s+-\s+-\s+1\s+changes_requested \(!\)\s+FAIL$/);
    expect(lines[4]).toMatch(/^broken\s+planted\s+0\/1\s+CONV-any\s+.*ERROR$/);
    expect(lines.at(-1)).toContain('recall 1/2 = 50%');
    expect(lines.at(-1)).toMatch(/FAIL$/);
  });
});
