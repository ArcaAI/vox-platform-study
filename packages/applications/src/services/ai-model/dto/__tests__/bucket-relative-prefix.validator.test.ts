/**
 * BucketRelativePrefixConstraint (TASK-960 D2) — `AiModel.bucketPrefix` must
 * be relative to the `hope-models` bucket root, never bucket-qualified.
 * `/mnt/models-bucket` (`HOPE_MODELS_MOUNT`) IS the bucket root, so a stored
 * prefix of `hope-models/x` makes `deriveLocalPath()` produce
 * `/mnt/models-bucket/hope-models/x` — a path that does not exist.
 */
import { describe, it, expect } from 'vitest';
import { BucketRelativePrefixConstraint, HOPE_MODELS_MOUNT } from '../../constants';

describe('BucketRelativePrefixConstraint', () => {
  const constraint = new BucketRelativePrefixConstraint();

  it('rejects a value that repeats the bucket name', () => {
    expect(constraint.validate('hope-models/x')).toBe(false);
  });

  it('rejects an s3:// URI', () => {
    expect(constraint.validate('s3://hope-models/x')).toBe(false);
  });

  it('names the bucket mount in the rejection message', () => {
    expect(constraint.defaultMessage()).toContain(HOPE_MODELS_MOUNT);
  });

  it('accepts a bucket-relative prefix with a trailing slash', () => {
    expect(constraint.validate('x/')).toBe(true);
  });

  it('accepts a nested bucket-relative prefix with a trailing slash', () => {
    expect(constraint.validate('x/y/')).toBe(true);
  });

  it('accepts an empty string — the documented "clear the field" sentinel on update', () => {
    expect(constraint.validate('')).toBe(true);
  });

  it('normalises a value with no trailing slash to have one', () => {
    expect(BucketRelativePrefixConstraint.normalize('x')).toBe('x/');
  });
});
