/**
 * TASK-1022 L-RESUME — a live handoff record left by an EARLIER recording is not the handoff of
 * the recording in progress.
 *
 * The record is keyed by consultation and survives for two hours. On a RESUMED governed
 * consultation the superseding governing run starts at the resumed stop and polls this read; with
 * the old rule (`ended` whenever a record exists) it answered at once with the FIRST recording's
 * note — before the resumed stop's drain had written the whole-visit one. A consultation that can
 * still record, or whose stop is still draining (the pending marker), has not handed off yet,
 * whatever an earlier stop left behind.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-stale';
const CID = 'consultation-stale-001';
const OLD_RECORD = { endedAt: '2026-09-30T08:10:00.000Z', tenantId: TENANT, outputs: { n_summary: { text: 'first recording only' } } };

function buildService(status: string, opts: { stored?: unknown; pending?: boolean } = {}) {
  const stored = new Map<string, string>();
  if (opts.stored !== undefined) stored.set(`live-doc:handoff:${CID}`, JSON.stringify(opts.stored));
  if (opts.pending) stored.set(`live-doc:handoff-pending:${CID}`, '2026-09-30T08:20:00.000Z');

  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    exists: vi.fn(async (key: string) => stored.has(key)),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  const args: unknown[] = new Array(28).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', departmentId: 'dept-1', status, metadata: null })),
  };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service };
}

describe('TASK-1022 L-RESUME — a stale handoff record does not end the live lane', () => {
  it('answers `ended: false` while the consultation records AGAIN, even with an earlier record in place', async () => {
    const { service } = buildService('RECORDING', { stored: OLD_RECORD });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).resolves.toEqual({ ended: false, outputs: {}, context: {} });
  });

  it('answers `ended: false` while the resumed stop is still draining (pending), even with an earlier record', async () => {
    const { service } = buildService('DRAINING', { stored: OLD_RECORD, pending: true });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).resolves.toMatchObject({ ended: false });
  });

  it('answers `ended: true` with the record once the drain has finished (pending cleared)', async () => {
    const { service } = buildService('DRAINING', { stored: OLD_RECORD });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.ended).toBe(true);
    expect(answer.outputs.n_summary).toEqual({ text: 'first recording only' });
  });
});
