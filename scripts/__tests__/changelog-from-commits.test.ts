/**
 * Tests for `scripts/changelog-from-commits.ts`.
 *
 * Parses Conventional Commits into the shape frozen by
 * and enforces the SemVer policy: a release with a breaking
 * commit must be a MAJOR bump.
 *
 * Pure-function tests only — git plumbing (`getCommitsInRange`,
 * `getPreviousFamilyTag`) is exercised separately via the CLI's manual run
 * against this repo's real history, not unit-tested
 * here, so these tests never depend on repository state.
 */

import { describe, expect, it } from 'vitest';
import {
  assertBreakingRequiresMajorBump,
  buildChangelog,
  buildDraftChangelogPayload,
  determineVersionBump,
  groupByType,
  parseConventionalCommit,
  type RawCommit,
} from '../changelog-from-commits';

function commit(overrides: Partial<RawCommit> & { subject: string }): RawCommit {
  return {
    sha: '0'.repeat(40),
    body: '',
    ...overrides,
  };
}

describe('parseConventionalCommit', () => {
  it('parses a plain feat commit with a TASK scope', () => {
    const c = commit({ subject: 'feat(TASK-643): implement provider credential veto handling', sha: 'a'.repeat(40) });
    const entry = parseConventionalCommit(c);
    expect(entry).toEqual({
      type: 'feat',
      scope: 'TASK-643',
      ticket: 'TASK-643',
      subject: 'implement provider credential veto handling',
      sha: 'a'.repeat(40),
      breaking: false,
    });
  });

  it('parses a fix commit with a BUG scope', () => {
    const c = commit({ subject: 'fix(BUG-12): correct off-by-one in pagination' });
    const entry = parseConventionalCommit(c);
    expect(entry.type).toBe('fix');
    expect(entry.scope).toBe('BUG-12');
    expect(entry.ticket).toBe('BUG-12');
    expect(entry.breaking).toBe(false);
  });

  it('parses a commit with no scope', () => {
    const c = commit({ subject: 'chore: bump dependency' });
    const entry = parseConventionalCommit(c);
    expect(entry.type).toBe('chore');
    expect(entry.scope).toBeNull();
    expect(entry.ticket).toBeNull();
    expect(entry.subject).toBe('bump dependency');
  });

  it('extracts a non-ticket scope as scope but leaves ticket null', () => {
    const c = commit({ subject: 'refactor(api): tidy guard order' });
    const entry = parseConventionalCommit(c);
    expect(entry.scope).toBe('api');
    expect(entry.ticket).toBeNull();
  });

  it('marks a `feat!:` commit as breaking via the bang marker', () => {
    const c = commit({ subject: 'feat!: remove the legacy v1 summary endpoint' });
    const entry = parseConventionalCommit(c);
    expect(entry.type).toBe('feat');
    expect(entry.breaking).toBe(true);
  });

  it('marks a `fix(scope)!:` commit as breaking', () => {
    const c = commit({ subject: 'fix(TASK-700)!: change the response shape of /health' });
    const entry = parseConventionalCommit(c);
    expect(entry.breaking).toBe(true);
    expect(entry.ticket).toBe('TASK-700');
  });

  it('hoists a BREAKING CHANGE footer even without a bang marker', () => {
    const c = commit({
      subject: 'feat(TASK-701): add a new provider field',
      body: 'Adds an optional field.\n\nBREAKING CHANGE: removes the old field entirely.',
    });
    const entry = parseConventionalCommit(c);
    expect(entry.breaking).toBe(true);
  });

  it('never drops a non-Conventional commit — lands as type "other"', () => {
    const c = commit({ subject: 'Merge branch dev-2.1 into feature/x' });
    const entry = parseConventionalCommit(c);
    expect(entry.type).toBe('other');
    expect(entry.scope).toBeNull();
    expect(entry.ticket).toBeNull();
    expect(entry.subject).toBe('Merge branch dev-2.1 into feature/x');
    expect(entry.breaking).toBe(false);
  });

  it('treats an unrecognized conventional-looking type as "other" rather than inventing a category', () => {
    const c = commit({ subject: 'wip: half-done spike' });
    const entry = parseConventionalCommit(c);
    expect(entry.type).toBe('other');
    expect(entry.subject).toBe('wip: half-done spike');
  });
});

describe('groupByType', () => {
  it('groups entries by their type, preserving order within each group', () => {
    const entries = [
      commit({ subject: 'feat(TASK-1): a' }),
      commit({ subject: 'fix(TASK-2): b' }),
      commit({ subject: 'feat(TASK-3): c' }),
    ].map(parseConventionalCommit);
    const grouped = groupByType(entries);
    expect(grouped.feat?.map((e) => e.subject)).toEqual(['a', 'c']);
    expect(grouped.fix?.map((e) => e.subject)).toEqual(['b']);
  });
});

describe('buildChangelog', () => {
  it('produces one entry per commit, always including the "other" bucket for non-parsing commits', () => {
    const raw: RawCommit[] = [
      commit({ subject: 'feat(TASK-1): thing one', sha: 'a'.repeat(40) }),
      commit({ subject: 'Merge pull request #4', sha: 'b'.repeat(40) }),
    ];
    const entries = buildChangelog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('feat');
    expect(entries[1].type).toBe('other');
  });

  it('matches the frozen changelog-entry schema shape (required keys present)', () => {
    const raw: RawCommit[] = [commit({ subject: 'fix(TASK-9): patch a leak', sha: 'c'.repeat(40) })];
    const [entry] = buildChangelog(raw);
    expect(Object.keys(entry).sort()).toEqual(['breaking', 'scope', 'sha', 'subject', 'ticket', 'type'].sort());
  });
});

describe('determineVersionBump', () => {
  it('returns "initial" when there is no previous tag', () => {
    expect(determineVersionBump(null, { major: 1, minor: 0, patch: 0 })).toBe('initial');
  });

  it('detects a major bump', () => {
    expect(determineVersionBump({ major: 1, minor: 4, patch: 2 }, { major: 2, minor: 0, patch: 0 })).toBe('major');
  });

  it('detects a minor bump', () => {
    expect(determineVersionBump({ major: 2, minor: 0, patch: 0 }, { major: 2, minor: 1, patch: 0 })).toBe('minor');
  });

  it('detects a patch bump', () => {
    expect(determineVersionBump({ major: 2, minor: 1, patch: 0 }, { major: 2, minor: 1, patch: 1 })).toBe('patch');
  });

  it('returns "none" when the version did not move', () => {
    expect(determineVersionBump({ major: 2, minor: 1, patch: 1 }, { major: 2, minor: 1, patch: 1 })).toBe('none');
  });
});

describe('assertBreakingRequiresMajorBump — the enforcement gate', () => {
  it('does not throw when no entry is breaking', () => {
    const entries = buildChangelog([commit({ subject: 'fix(TASK-1): ok' })]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'minor')).not.toThrow();
  });

  it('does not throw when a breaking entry meets a major bump', () => {
    const entries = buildChangelog([commit({ subject: 'feat!: remove v1' })]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'major')).not.toThrow();
  });

  it('does not throw on an initial release even with a breaking-shaped commit', () => {
    const entries = buildChangelog([commit({ subject: 'feat!: first cut' })]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'initial')).not.toThrow();
  });

  it('THROWS when a breaking entry meets a minor bump — this is the enforced-not-aspirational gate', () => {
    const entries = buildChangelog([
      commit({ subject: 'feat(TASK-9)!: drop the legacy field', sha: 'd'.repeat(40) }),
      commit({ subject: 'fix(TASK-10): unrelated patch', sha: 'e'.repeat(40) }),
    ]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'minor')).toThrow(/breaking/i);
  });

  it('THROWS when a breaking entry meets a patch bump', () => {
    const entries = buildChangelog([commit({ subject: 'fix!: changes the response shape' })]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'patch')).toThrow(/breaking/i);
  });

  it('the thrown error names the offending commit sha(s)', () => {
    const entries = buildChangelog([commit({ subject: 'feat!: break it', sha: 'f'.repeat(40) })]);
    expect(() => assertBreakingRequiresMajorBump(entries, 'minor')).toThrow(new RegExp('f'.repeat(40)));
  });
});

describe('buildDraftChangelogPayload — ALL- tag draft ChangelogEntry', () => {
  it('pulls feat + breaking items into title/summary/body, never publishing', () => {
    const entries = buildChangelog([
      commit({ subject: 'feat(TASK-1): add Malayalam TTS', sha: 'a'.repeat(40) }),
      commit({ subject: 'fix(TASK-2): quiet a flaky log line', sha: 'b'.repeat(40) }),
      commit({ subject: 'feat(TASK-3)!: remove the v1 compat shim', sha: 'c'.repeat(40) }),
    ]);
    const payload = buildDraftChangelogPayload(entries, '2.2.0');

    expect(payload.platformVersion).toBe('2.2.0');
    expect(payload.title).toContain('2.2.0');
    expect(payload.body).toContain('add Malayalam TTS');
    expect(payload.body).toContain('remove the v1 compat shim');
    // The plain fix (non-breaking, non-feat) is not pulled into the curated draft.
    expect(payload.body).not.toContain('quiet a flaky log line');
    // No publish-shaped field exists on the payload — CI only ever creates a DRAFT
    // and publishing is a human action via the API.
    expect(payload).not.toHaveProperty('publishStatus');
    expect(payload).not.toHaveProperty('publishedAt');
  });

  it('produces a non-empty summary even with only fixes (no feat/breaking items)', () => {
    const entries = buildChangelog([commit({ subject: 'fix(TASK-1): patch', sha: 'a'.repeat(40) })]);
    const payload = buildDraftChangelogPayload(entries, '2.2.1');
    expect(payload.summary.length).toBeGreaterThan(0);
  });
});
