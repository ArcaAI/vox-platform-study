/**
 * TASK-407 — Stores detail display helpers.
 * Design: `unbuilt-super-admin-surfaces.md` §2 "Stores" (spec-only): bucket
 * table w/ objects · size · quota; Store Detail w/ usage vs quota.
 */

import { describe, it, expect } from 'vitest';
import { objectsTotalBytes, quotaPct, fileNameOf, bucketTypeLabel, keysForBucket } from '../store-format';

describe('objectsTotalBytes', () => {
  it('sums object sizes', () => {
    expect(
      objectsTotalBytes([
        { key: 'a', size: 100 },
        { key: 'b', size: 250 },
      ]),
    ).toBe(350);
  });

  it('returns 0 for an empty list and ignores non-numeric sizes', () => {
    expect(objectsTotalBytes([])).toBe(0);
    expect(
      objectsTotalBytes([
        { key: 'a', size: Number.NaN },
        { key: 'b', size: 10 },
      ]),
    ).toBe(10);
  });
});

describe('quotaPct', () => {
  it('computes the used percentage rounded to an integer', () => {
    expect(quotaPct(512, 1024)).toBe(50);
    expect(quotaPct(1, 3)).toBe(33);
  });

  it('clamps to 100 when over quota', () => {
    expect(quotaPct(2048, 1024)).toBe(100);
  });

  it('returns null when the quota is unlimited (null/0/undefined)', () => {
    expect(quotaPct(512, null)).toBeNull();
    expect(quotaPct(512, undefined)).toBeNull();
    expect(quotaPct(512, 0)).toBeNull();
  });
});

describe('fileNameOf', () => {
  it('returns the last path segment of an object key', () => {
    expect(fileNameOf('2026/07/01/streaming/file.wav')).toBe('file.wav');
    expect(fileNameOf('plain.txt')).toBe('plain.txt');
  });

  it('falls back to the full key for trailing-slash keys', () => {
    expect(fileNameOf('folder/')).toBe('folder/');
  });
});

describe('bucketTypeLabel', () => {
  it('labels SYSTEM/CUSTOM and echoes unknown values', () => {
    expect(bucketTypeLabel('SYSTEM')).toBe('System');
    expect(bucketTypeLabel('CUSTOM')).toBe('Custom');
    expect(bucketTypeLabel('SOMETHING')).toBe('SOMETHING');
    expect(bucketTypeLabel(undefined)).toBe('—');
  });
});

describe('keysForBucket', () => {
  const keys = [{ id: 'all', bucketIds: [] }, { id: 'mine', bucketIds: ['b1'] }, { id: 'other', bucketIds: ['b2'] }, { id: 'unscoped' }];

  it('keeps all-bucket keys and keys scoped to the bucket', () => {
    expect(keysForBucket(keys, 'b1').map((k) => k.id)).toEqual(['all', 'mine', 'unscoped']);
  });

  it('drops keys scoped to other buckets only', () => {
    expect(keysForBucket(keys, 'b3').map((k) => k.id)).toEqual(['all', 'unscoped']);
  });
});
