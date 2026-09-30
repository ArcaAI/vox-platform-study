/**
 * TASK-1023 B1 — one normaliser for a path in the models bucket, and a validator that no longer
 * lets a pasted mount path through.
 *
 * An admin may paste the path the way they see it anywhere: as the mount a serving pod sees
 * (`/mnt/models-bucket/x`), bucket-qualified (`hope-models/x`), as an S3 URI
 * (`s3://hope-models/x`), or bare (`x`). All four name the same bucket prefix `x/`.
 */
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BucketRelativePrefixConstraint, normaliseBucketPath } from '../constants';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof BadRequestException) return (error.getResponse() as { code?: string }).code;
    throw error;
  }
  return undefined;
}

describe('normaliseBucketPath', () => {
  it.each([
    ['/mnt/models-bucket/x/', 'x/'],
    ['/mnt/models-bucket/x', 'x/'],
    ['hope-models/x', 'x/'],
    ['hope-models/x/', 'x/'],
    ['s3://hope-models/x/', 'x/'],
    ['S3://hope-models/x', 'x/'],
    ['x', 'x/'],
    ['/x/y/', 'x/y/'],
    ['  x//y  ', 'x/y/'],
    ['/mnt/models-bucket/hf/hub/models--o--n/snapshots/abc/', 'hf/hub/models--o--n/snapshots/abc/'],
  ])('%j → %j', (input, expected) => {
    expect(normaliseBucketPath(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['/'],
    ['hope-models'],
    ['/mnt/models-bucket'],
    ['s3://hope-models/'],
    ['a/../b'],
    ['./a'],
    ['a/./b'],
    ['..'],
    ['s3://other-bucket/x'],
  ])('%j → 400 PATH_INVALID', (input) => {
    expect(codeOf(() => normaliseBucketPath(input))).toBe('PATH_INVALID');
  });
});

describe('BucketRelativePrefixConstraint — the mount path', () => {
  const constraint = new BucketRelativePrefixConstraint();

  it('rejects a prefix that starts with the mount path (it would derive /mnt/models-bucket/mnt/models-bucket/…)', () => {
    expect(constraint.validate('/mnt/models-bucket/x')).toBe(false);
    expect(constraint.validate('/mnt/models-bucket/x/')).toBe(false);
    expect(constraint.validate('mnt/models-bucket/x/')).toBe(false);
  });

  it('still accepts a bucket-relative prefix', () => {
    expect(constraint.validate('x/')).toBe(true);
    expect(constraint.validate('mnt-models/x/')).toBe(true);
  });
});
