/** TASK-1019 (Lane C) — the list polls every 5 s while any row is transient, and not at all otherwise. */

import { describe, expect, it } from 'vitest';
import { modelWith, envelope } from '../../components/__tests__/fixtures.task1019';
import { LIFECYCLE_POLL_MS, hasTransientRows, listRefetchInterval } from '../lifecycle';

describe('list polling (OD-5)', () => {
  it.each(['DOWNLOADING', 'UNREGISTERING', 'LOADING'] as const)('polls every 5 s while a row is %s', (status) => {
    const page = envelope([modelWith('a', 'A', 'SERVING'), modelWith('b', 'B', status)]);
    expect(listRefetchInterval(page)).toBe(LIFECYCLE_POLL_MS);
    expect(LIFECYCLE_POLL_MS).toBe(5_000);
  });

  it.each(['SERVING', 'DOWNLOADED', 'DOWNLOAD_FAILED', 'LOAD_FAILED', 'NOT_DOWNLOADED', 'NOT_OBSERVED', 'NOT_APPLICABLE'] as const)(
    'does not poll when the only status is %s',
    (status) => {
      expect(listRefetchInterval(envelope([modelWith('a', 'A', status)]))).toBe(false);
    },
  );

  it('does not poll on an empty page, before the first read, or for rows without a lifecycle', () => {
    expect(listRefetchInterval(envelope([]))).toBe(false);
    expect(listRefetchInterval(undefined)).toBe(false);
    expect(hasTransientRows([{ ...modelWith('a', 'A', 'SERVING'), lifecycle: null }])).toBe(false);
  });
});
