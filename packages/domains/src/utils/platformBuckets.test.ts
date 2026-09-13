import { describe, expect, it } from 'vitest';
import { PLATFORM_BUCKET_NAMES, isPlatformBucket } from './platformBuckets';

describe('isPlatformBucket', () => {
  it.each(PLATFORM_BUCKET_NAMES)('recognises the platform bucket %s', (name) => {
    expect(isPlatformBucket(name)).toBe(true);
  });

  it('normalises case and surrounding whitespace before matching', () => {
    expect(isPlatformBucket('  Hope-Models  ')).toBe(true);
    expect(isPlatformBucket('MLFLOW')).toBe(true);
  });

  it.each([null, undefined, '', '   '])('is false for the empty-ish value %p', (value) => {
    expect(isPlatformBucket(value)).toBe(false);
  });

  // A prefix heuristic would be wrong in both directions, which is why the
  // registry is an explicit list.
  it('does not match a tenant bucket that merely shares the hope- prefix', () => {
    expect(isPlatformBucket('hope-models-arcaai')).toBe(false);
    expect(isPlatformBucket('hope-recordings-arcaai')).toBe(false);
    expect(isPlatformBucket('hope-attachments-global')).toBe(false);
  });

  it('does not match an ordinary orphaned bucket', () => {
    expect(isPlatformBucket('legacy-exports')).toBe(false);
  });

  // `hope-models` is the one the storage browser surfaces most visibly, and
  // adopting it would put an object-locked weights bucket behind a tenant
  // delete button.
  it('covers hope-models specifically', () => {
    expect(isPlatformBucket('hope-models')).toBe(true);
  });

  // These two are created at RUNTIME by STT rather than by the compose
  // bootstrap, so they are easy to leave out of a list derived from the
  // bootstrap alone — both were sitting in dev MinIO on the first pass.
  it('covers the global STT audio buckets', () => {
    expect(isPlatformBucket('hope-audio')).toBe(true);
    expect(isPlatformBucket('hope-audio-chunks')).toBe(true);
  });

  // `TenantBucketFactory.buildBucketName` produces `hope-<slug>-<tenantKey>`,
  // so a tenant keyed `chunks` asking for slug `audio` derives exactly
  // `hope-audio-chunks`. The guard is on the derived NAME for this reason.
  it('matches a derived tenant name that collides with a platform bucket', () => {
    const derived = `hope-${'audio'}-${'chunks'}`;
    expect(derived).toBe('hope-audio-chunks');
    expect(isPlatformBucket(derived)).toBe(true);
  });
});
