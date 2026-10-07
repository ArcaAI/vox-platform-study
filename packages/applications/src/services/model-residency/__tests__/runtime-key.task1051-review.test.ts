import { describe, expect, it } from 'vitest';
import { resolveRuntimeKey } from '../runtime-key';

/**
 * TASK-1051 review finding 1 — ONE ranked resolver from a reported engine key to a catalogue row:
 * the row whose catalogue ref IS the key, then a row that confirmed the key, then — only when it is
 * unambiguous — the row whose ref normalises to the same key. A normalised key that two rows share
 * is UNMATCHED (the catalogue then offers candidates); it is never handed to the first row found.
 */
describe('resolveRuntimeKey', () => {
  const foo = { id: 'foo', slug: 'lms-foo', sourceUri: 'x', wireModelId: 'foo' };
  const fooQ8 = { id: 'foo-q8', slug: 'lms-foo-q8', sourceUri: 'x', wireModelId: 'foo@q8_0' };
  const bar = { id: 'bar', slug: 'lms-bar', sourceUri: 'x', wireModelId: 'bar' };

  it('an exact catalogue ref wins over every other row, even one that normalises to the same key', () => {
    expect(resolveRuntimeKey('lm-studio', 'foo@q8_0', [foo, fooQ8])?.row.id).toBe('foo-q8');
    expect(resolveRuntimeKey('lm-studio', 'foo', [fooQ8, foo])?.row.id).toBe('foo');
  });

  it('an operator-confirmed key wins over a normalised match', () => {
    const linked = { ...bar, metaData: { residency: { runtimeKeys: ['foo@q4_0'] } } };
    expect(resolveRuntimeKey('lm-studio', 'foo@q4_0', [foo, linked])?.row.id).toBe('bar');
  });

  it('a normalised key that names exactly ONE row resolves to it', () => {
    expect(resolveRuntimeKey('lm-studio', 'foo@q4_0:2', [foo, bar])?.row.id).toBe('foo');
  });

  it('a normalised key shared by two rows is UNMATCHED', () => {
    expect(resolveRuntimeKey('lm-studio', 'foo@q4_0', [foo, fooQ8])).toBeNull();
  });

  it('stays exact for stt and nlp, and is null for an unknown key', () => {
    expect(resolveRuntimeKey('stt', 'radiology', [{ id: 'r', slug: 'radiology', sourceUri: 'x' }])?.row.id).toBe('r');
    expect(resolveRuntimeKey('stt', 'radiology@q8', [{ id: 'r', slug: 'radiology', sourceUri: 'x' }])).toBeNull();
    expect(resolveRuntimeKey('lm-studio', 'nothing', [foo, bar])).toBeNull();
  });

  it('reports HOW it matched', () => {
    const linked = { ...bar, metaData: { residency: { runtimeKeys: ['custom'] } } };
    expect(resolveRuntimeKey('lm-studio', 'foo', [foo])?.via).toBe('exact');
    expect(resolveRuntimeKey('lm-studio', 'custom', [linked])?.via).toBe('confirmed');
    expect(resolveRuntimeKey('lm-studio', 'foo@q4_0', [foo])?.via).toBe('normalised');
  });
});
