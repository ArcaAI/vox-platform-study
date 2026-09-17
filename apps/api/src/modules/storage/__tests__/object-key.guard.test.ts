/**
 * TASK-983 R7 / OD-5 — `assertSafeObjectKey` table test.
 *
 * Every `TenantBucket.pathPattern` is date-segmented
 * (`{yyyy}/{MM}/{dd}` etc., `TenantBucketFactory.ts`), so a real object key
 * always contains internal `/`. The legacy guard rejected ANY `/`, 400'ing
 * every legitimate download. OD-5 approved: internal `/` is allowed; a
 * leading `/`, a `\`, or a `.`/`..` path segment stays rejected.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertSafeObjectKey } from '../object-key.guard';

describe('assertSafeObjectKey', () => {
  const SAFE_KEYS = ['2026/09/17/file.wav', 'patients/2026/report-1.txt', 'a.b/c.d'] as const;

  it.each(SAFE_KEYS)('allows %j (internal / permitted per OD-5)', (key) => {
    expect(() => assertSafeObjectKey(key)).not.toThrow();
  });

  const UNSAFE_KEYS = ['..', 'a/../b', '../x', '/etc/passwd', '..\\x', 'a\\b', ''] as const;

  it.each(UNSAFE_KEYS)('rejects %j with BadRequestException', (key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(BadRequestException);
    expect(() => assertSafeObjectKey(key)).toThrow('Invalid file key: path traversal not allowed');
  });
});
