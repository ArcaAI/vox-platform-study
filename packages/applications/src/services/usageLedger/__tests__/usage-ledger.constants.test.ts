/**
 * TASK-615 WS-D2 (item 4c) — the outbox-drain BullMQ queue name is promoted
 * into the shared `JobQueue` enum home (`@arcaai/domains`), per the WS-B
 * handoff ("Promoting AiUsageOutboxDrain into the shared JobQueue enum").
 *
 * `USAGE_OUTBOX_QUEUE` stays exported from this module (it is the value every
 * other file in this lane imports), but it now REFERENCES the enum member
 * rather than duplicating the string literal — so a rename of one can never
 * silently drift from the other.
 */
import { describe, expect, it } from 'vitest';
import { JobQueue } from '@arcaai/domains';
import { USAGE_OUTBOX_QUEUE } from '../usage-ledger.constants';

describe('USAGE_OUTBOX_QUEUE', () => {
  it('is the JobQueue.AiUsageOutboxDrain member, not a local string literal', () => {
    expect(USAGE_OUTBOX_QUEUE).toBe(JobQueue.AiUsageOutboxDrain);
  });

  it('still resolves to the historical queue name (no silent rename)', () => {
    expect(USAGE_OUTBOX_QUEUE).toBe('AiUsageOutboxDrain');
  });
});
