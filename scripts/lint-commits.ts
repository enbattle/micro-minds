// Conventional Commits lint for commit subjects and PR titles (no third-party action, no deps).
//
//   node scripts/lint-commits.ts --range <base>..<head>   lint `git log --format=%s <range>`
//   PR_TITLE='feat: x' node scripts/lint-commits.ts --title   lint the PR title
//
// The PR title is read from the environment, never from argv, so CI passes it via `env:` and
// the title's contents never reach a shell. Failures go to stderr; exit 1 on any failure.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

export const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export const MAX_SUBJECT_LENGTH = 100;

export type CheckResult = { ok: true } | { ok: false; reason: string };
export type Failure = { subject: string; reason: string };

const HEADER = new RegExp(`^(${TYPES.join('|')})(\\(([^)]*)\\))?(!)?: (.*)$`);
const SCOPE = /^[a-z0-9][a-z0-9/-]*$/;

// Subjects git or GitHub generate, which are not ours to reformat.
const GENERATED = [
  /^Merge pull request #\d+/,
  /^Merge branch '[^']+'/,
  /^Merge remote-tracking branch '[^']+'/,
  /^Revert ".+"$/,
  // GitHub's default first commit when a repository is created with a README/licence.
  /^Initial commit$/,
];

export function checkSubject(subject: string): CheckResult {
  if (GENERATED.some((re) => re.test(subject))) return { ok: true };

  if (subject.trim() === '') return { ok: false, reason: 'subject is empty' };
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      reason: `subject is ${subject.length} characters (max ${MAX_SUBJECT_LENGTH})`,
    };
  }

  const match = HEADER.exec(subject);
  if (!match) {
    return {
      ok: false,
      reason: `expected "type(scope)?!?: description" with type one of ${TYPES.join(', ')}`,
    };
  }

  const [, , scopeGroup, scope, , description = ''] = match;
  if (scopeGroup !== undefined && (scope === undefined || !SCOPE.test(scope))) {
    return {
      ok: false,
      reason: 'scope must be non-empty lowercase letters, digits, "-" or "/"',
    };
  }
  if (description.trim() === '') return { ok: false, reason: 'description is empty' };
  if (!/^[a-z0-9`]/.test(description)) {
    return {
      ok: false,
      reason: 'description must start with a lowercase letter, a digit or a backtick',
    };
  }
  if (description.endsWith('.')) {
    return { ok: false, reason: 'description must not end with a period' };
  }
  return { ok: true };
}

export function checkSubjects(subjects: readonly string[]): Failure[] {
  const failures: Failure[] = [];
  for (const subject of subjects) {
    const result = checkSubject(subject);
    if (!result.ok) failures.push({ subject, reason: result.reason });
  }
  return failures;
}

function subjectsInRange(range: string): string[] | null {
  // A leading "-" would be parsed by git as an option (e.g. --output=<file>).
  if (range.startsWith('-')) {
    console.error(`lint-commits: invalid range ${JSON.stringify(range)}`);
    return null;
  }
  try {
    const out = execFileSync('git', ['log', '--format=%s', range, '--'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').filter((line) => line !== '');
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : String(error);
    console.error(`lint-commits: git log ${range} failed: ${stderr}`);
    return null;
  }
}

function main(argv: readonly string[]): number {
  let subjects: string[];
  const [flag, value] = argv;
  if (flag === '--range' && value !== undefined && argv.length === 2) {
    const inRange = subjectsInRange(value);
    if (inRange === null) return 1;
    subjects = inRange;
  } else if (flag === '--title' && argv.length === 1) {
    const title = process.env.PR_TITLE;
    if (title === undefined) {
      console.error('lint-commits: --title reads the PR title from the PR_TITLE env variable');
      return 1;
    }
    subjects = [title];
  } else {
    console.error(
      'usage: node scripts/lint-commits.ts --range <base>..<head>\n' +
        '       PR_TITLE=<title> node scripts/lint-commits.ts --title',
    );
    return 1;
  }

  const failures = checkSubjects(subjects);
  for (const { subject, reason } of failures) {
    console.error(`✖ ${JSON.stringify(subject)}: ${reason}`);
  }
  if (failures.length > 0) {
    console.error(
      `lint-commits: ${failures.length} of ${subjects.length} subject(s) are not Conventional ` +
        'Commits (https://www.conventionalcommits.org). Reword with `git rebase` or edit the PR title.',
    );
    return 1;
  }
  console.log(`lint-commits: ${subjects.length} subject(s) OK`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
