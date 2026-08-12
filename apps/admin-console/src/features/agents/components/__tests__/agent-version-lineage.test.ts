import { describe, expect, it } from 'vitest';
import { diffConfigSnapshots, formatSnapshotValue } from '../agent-version-lineage';

describe('diffConfigSnapshots', () => {
  it('returns no entries for identical snapshots', () => {
    expect(diffConfigSnapshots({ role: 'SPECIALIST', guardrailProfile: 'STANDARD' }, { role: 'SPECIALIST', guardrailProfile: 'STANDARD' })).toEqual([]);
  });

  it('reports only the fields that changed, sorted by field name', () => {
    const before = { role: 'SPECIALIST', guardrailProfile: 'STANDARD', goal: { objective: 'a' } };
    const after = { role: 'PRIMARY', guardrailProfile: 'STANDARD', goal: { objective: 'a' } };
    expect(diffConfigSnapshots(before, after)).toEqual([{ field: 'role', before: 'SPECIALIST', after: 'PRIMARY' }]);
  });

  it('reports a field added in the newer snapshot (before is undefined)', () => {
    expect(diffConfigSnapshots({ role: 'SPECIALIST' }, { role: 'SPECIALIST', neverActions: ['harness.finalize'] })).toEqual([
      { field: 'neverActions', before: undefined, after: ['harness.finalize'] },
    ]);
  });

  it('reports a field removed in the newer snapshot (after is undefined)', () => {
    expect(diffConfigSnapshots({ role: 'SPECIALIST', neverActions: ['harness.finalize'] }, { role: 'SPECIALIST' })).toEqual([
      { field: 'neverActions', before: ['harness.finalize'], after: undefined },
    ]);
  });

  it('compares nested object/array values structurally, not by reference', () => {
    const before = { subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } };
    const after = { subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } };
    expect(diffConfigSnapshots(before, after)).toEqual([]);
  });

  it('degrades to comparing against an empty object for null/undefined snapshots', () => {
    expect(diffConfigSnapshots(null, { role: 'PRIMARY' })).toEqual([{ field: 'role', before: undefined, after: 'PRIMARY' }]);
    expect(diffConfigSnapshots({ role: 'PRIMARY' }, undefined)).toEqual([{ field: 'role', before: 'PRIMARY', after: undefined }]);
  });
});

describe('formatSnapshotValue', () => {
  it('renders an em dash for undefined, the literal for null, and the raw string for a string', () => {
    expect(formatSnapshotValue(undefined)).toBe('—');
    expect(formatSnapshotValue(null)).toBe('null');
    expect(formatSnapshotValue('PRIMARY')).toBe('PRIMARY');
  });

  it('renders compact JSON for objects/arrays', () => {
    expect(formatSnapshotValue(['a', 'b'])).toBe('["a","b"]');
    expect(formatSnapshotValue({ version: 1 })).toBe('{"version":1}');
  });
});
