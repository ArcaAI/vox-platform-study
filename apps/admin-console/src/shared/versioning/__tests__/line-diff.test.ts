/**
 * TASK-965 WS-3 — the client-side line diff behind `VersionCompareDialog` (owner decision
 * OD-965-7: compare is CLIENT-side in 965; no backend diff route). The versions routes already
 * return full bodies, so the only thing missing was the comparison itself.
 *
 * `toComparableJson` is the half that makes a diff MEAN something: two payloads that differ only
 * in key order are the same configuration, and a diff that reports every line changed because
 * `JSON.stringify` walked the keys differently would train an admin to ignore it.
 */
import { describe, expect, it } from 'vitest';
import { diffLines, toComparableJson } from '../line-diff';

describe('toComparableJson', () => {
  it('serialises objects with a stable key order, so key order alone is not a change', () => {
    expect(toComparableJson({ b: 1, a: 2 })).toBe(toComparableJson({ a: 2, b: 1 }));
  });

  it('keeps array order, which IS meaningful', () => {
    expect(toComparableJson([1, 2])).not.toBe(toComparableJson([2, 1]));
  });

  it('passes a string through unchanged (a prompt body is not JSON)', () => {
    expect(toComparableJson('line one\nline two')).toBe('line one\nline two');
  });

  it('renders nullish payloads as an empty document rather than "undefined"', () => {
    expect(toComparableJson(undefined)).toBe('');
    expect(toComparableJson(null)).toBe('');
  });
});

describe('diffLines', () => {
  it('reports an identical pair as identical with no changes', () => {
    const diff = diffLines('a\nb', 'a\nb');
    expect(diff.identical).toBe(true);
    expect(diff.stats).toEqual({ additions: 0, deletions: 0 });
  });

  it('classifies added, removed and context lines with their line numbers', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diff.stats).toEqual({ additions: 1, deletions: 1 });
    const removed = diff.lines.find((line) => line.kind === 'removed');
    const added = diff.lines.find((line) => line.kind === 'added');
    expect(removed).toMatchObject({ text: 'b', fromLine: 2, toLine: null });
    expect(added).toMatchObject({ text: 'B', fromLine: null, toLine: 2 });
    expect(diff.lines.filter((line) => line.kind === 'context').map((line) => line.text)).toEqual(['a', 'c']);
  });

  it('keeps the longest common subsequence rather than re-emitting the whole document', () => {
    const diff = diffLines('a\nb\nc\nd', 'a\nc\nd');
    expect(diff.stats).toEqual({ additions: 0, deletions: 1 });
    expect(diff.lines.filter((line) => line.kind === 'context')).toHaveLength(3);
  });

  it('counts a pure insertion at the end', () => {
    const diff = diffLines('a', 'a\nb\nc');
    expect(diff.stats).toEqual({ additions: 2, deletions: 0 });
  });

  it('falls back to a whole-document replacement beyond the size cap, and says so', () => {
    const from = Array.from({ length: 30 }, (_, index) => `from-${index}`).join('\n');
    const to = Array.from({ length: 30 }, (_, index) => `to-${index}`).join('\n');
    const diff = diffLines(from, to, { maxLines: 10 });
    expect(diff.truncated).toBe(true);
    expect(diff.stats).toEqual({ additions: 30, deletions: 30 });
    expect(diff.lines.every((line) => line.kind !== 'context')).toBe(true);
  });
});
