/**
 * ConsultationLoopEventService Unit Tests.
 *
 * The ephemeral loop-output feed: `publishEvent` publishes ONE
 * self-contained event on `consultation:loop:{consultationId}` — append-only,
 * no fold/snapshot (mirrors the trajectory stream, not harness-progress).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationLoopEventService } from '../consultation-loop-event.service';

const CID = 'consult-loop-1';
const CHANNEL = `consultation:loop:${CID}`;

function buildDeps() {
  const cacheService = { publish: vi.fn().mockResolvedValue(undefined) };
  const service = new ConsultationLoopEventService(cacheService as any);
  return { service, cacheService };
}

describe('ConsultationLoopEventService', () => {
  it('publishes a self-contained event on consultation:loop:{id}', async () => {
    const { service, cacheService } = buildDeps();

    const ack = await service.publishEvent(CID, {
      tenantId: 'tenant-1',
      runId: 'run-1',
      kind: 'action.started',
      label: 'Extracting entities',
      data: { action: 'nlp.extract_entities' },
    });

    expect(ack).toEqual({ ok: true });
    expect(cacheService.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = cacheService.publish.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    const parsed = JSON.parse(message);
    expect(parsed).toEqual(
      expect.objectContaining({
        consultationId: CID,
        tenantId: 'tenant-1',
        runId: 'run-1',
        kind: 'action.started',
        label: 'Extracting entities',
        data: { action: 'nlp.extract_entities' },
      }),
    );
    expect(typeof parsed.publishedAt).toBe('string');
  });

  it('publishes with only the required fields (tenantId + kind)', async () => {
    const { service, cacheService } = buildDeps();

    await service.publishEvent(CID, { tenantId: 'tenant-1', kind: 'action.completed' } as any);

    const [, message] = cacheService.publish.mock.calls[0];
    const parsed = JSON.parse(message);
    expect(parsed.kind).toBe('action.completed');
    expect(parsed.runId).toBeUndefined();
  });

  it('returns { ok: false } instead of throwing when Redis publish fails (best-effort — loop unaffected)', async () => {
    const cacheService = { publish: vi.fn().mockRejectedValue(new Error('redis down')) };
    const service = new ConsultationLoopEventService(cacheService as any);

    const ack = await service.publishEvent(CID, { tenantId: 'tenant-1', kind: 'action.started' } as any);

    expect(ack).toEqual({ ok: false });
  });
});
