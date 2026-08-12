/**
 * LoopContextSignalService Unit Tests.
 *
 * The new @OnEvent(ContextAdded) consumer (TASK-660) that signals the
 * (future) consultation loop workflow via HarnessGatewayService.
 * signalContextAdded. Covers:
 *   - no-op when the loop is not configured (HARNESS_LOOP_ENABLED unset/false)
 *   - signals the gateway when enabled
 *   - idempotent under duplicate emission (same consultationId + contextItemId
 *     + timestamp signals exactly once)
 *   - a fresh emission for the SAME contextItemId (e.g. OCR re-emit with new
 *     content — different timestamp) is NOT treated as a duplicate
 *   - never throws when the gateway call fails (best-effort)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoopContextSignalService } from '../loop-context-signal.service';
import type { ContextAddedPayload } from '../../events';

// NOTE: no default value here — `buildDeps(undefined)` must leave
// `loopEnabled` genuinely `undefined` (a default param would silently
// substitute a fallback for an explicit `undefined` argument too).
function buildDeps(loopEnabled?: string) {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const configService = { get: vi.fn((key: string) => (key === 'HARNESS_LOOP_ENABLED' ? loopEnabled : undefined)) };
  const service = new LoopContextSignalService(harnessGatewayService as any, configService as any);
  return { service, harnessGatewayService, configService };
}

function payload(overrides: Partial<ContextAddedPayload> = {}): ContextAddedPayload {
  return {
    consultationId: 'consultation-1',
    tenantId: 'tenant-1',
    timestamp: '2026-08-11T10:00:00.000Z',
    contextItemId: 'ctx-1',
    contextType: 'WORKNOTE',
    ...overrides,
  };
}

describe('LoopContextSignalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when HARNESS_LOOP_ENABLED is unset (no loop configured)', async () => {
    const { service, harnessGatewayService } = buildDeps(undefined);

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('is a no-op when HARNESS_LOOP_ENABLED=false', async () => {
    const { service, harnessGatewayService } = buildDeps('false');

    await service.handleContextAdded(payload());

    expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
  });

  it('signals the harness gateway when HARNESS_LOOP_ENABLED=true', async () => {
    const { service, harnessGatewayService } = buildDeps('true');

    await service.handleContextAdded(
      payload({ subType: 'LAB_RESULT', contentPreview: 'BP elevated' }),
    );

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith('consultation-1', {
      tenantId: 'tenant-1',
      contextItemId: 'ctx-1',
      contextType: 'WORKNOTE',
      subType: 'LAB_RESULT',
      contentPreview: 'BP elevated',
      kindKey: undefined,
      occurredAt: '2026-08-11T10:00:00.000Z',
      depth: 0,
      content: undefined,
    });
  });

  // TASK-670 — payload completeness: kindKey/occurredAt/depth/content now
  // ride the outbound signal.
  it('forwards kindKey, occurredAt (the payload timestamp), depth, and the fuller content field', async () => {
    const { service, harnessGatewayService } = buildDeps('true');

    await service.handleContextAdded(
      payload({
        kindKey: 'referral_letter',
        timestamp: '2026-08-12T09:00:00.000Z',
        depth: 2,
        content: 'The full body of the note, longer than the 2k preview.',
      }),
    );

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith(
      'consultation-1',
      expect.objectContaining({
        kindKey: 'referral_letter',
        occurredAt: '2026-08-12T09:00:00.000Z',
        depth: 2,
        content: 'The full body of the note, longer than the 2k preview.',
      }),
    );
  });

  it('defaults depth to 0 when the payload carries no depth', async () => {
    const { service, harnessGatewayService } = buildDeps('true');

    await service.handleContextAdded(payload({ depth: undefined }));

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith(
      'consultation-1',
      expect.objectContaining({ depth: 0 }),
    );
  });

  it('is idempotent under duplicate emission (identical payload signals exactly once)', async () => {
    const { service, harnessGatewayService } = buildDeps('true');
    const event = payload();

    await service.handleContextAdded(event);
    await service.handleContextAdded(event);
    await service.handleContextAdded({ ...event });

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
  });

  it('signals again for a re-emission of the SAME contextItemId carrying a new timestamp (OCR enrichment re-emit — not a duplicate)', async () => {
    const { service, harnessGatewayService } = buildDeps('true');

    await service.handleContextAdded(payload({ timestamp: '2026-08-11T10:00:00.000Z', contentPreview: 'placeholder' }));
    await service.handleContextAdded(payload({ timestamp: '2026-08-11T10:00:05.000Z', contentPreview: 'OCR text' }));

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(2);
  });

  it('never throws when the gateway call fails (best-effort — the context-add path must not break)', async () => {
    const { service, harnessGatewayService } = buildDeps('true');
    harnessGatewayService.signalContextAdded.mockRejectedValue(new Error('harness unreachable'));

    await expect(service.handleContextAdded(payload())).resolves.toBeUndefined();
  });

  // TASK-670 — the two lifecycle-boundary signal callers.
  describe('signalConsultationEnding', () => {
    it('is a no-op when the loop is not configured', async () => {
      const { service, harnessGatewayService } = buildDeps(undefined);

      await service.signalConsultationEnding('consultation-1', { reason: 'recording_stopped' });

      expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
    });

    it('forwards the payload to the harness gateway when enabled', async () => {
      const { service, harnessGatewayService } = buildDeps('true');

      await service.signalConsultationEnding('consultation-1', { reason: 'recording_stopped', persistSnapshot: true });

      expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith('consultation-1', {
        reason: 'recording_stopped',
        persistSnapshot: true,
      });
    });

    it('never throws when the gateway call fails (best-effort)', async () => {
      const { service, harnessGatewayService } = buildDeps('true');
      harnessGatewayService.signalConsultationEnding.mockRejectedValue(new Error('harness unreachable'));

      await expect(service.signalConsultationEnding('consultation-1', {})).resolves.toBeUndefined();
    });
  });

  describe('signalLoopCancel', () => {
    it('is a no-op when the loop is not configured', async () => {
      const { service, harnessGatewayService } = buildDeps(undefined);

      await service.signalLoopCancel('consultation-1', { reason: 'abandoned' });

      expect(harnessGatewayService.signalLoopCancel).not.toHaveBeenCalled();
    });

    it('forwards the payload to the harness gateway when enabled', async () => {
      const { service, harnessGatewayService } = buildDeps('true');

      await service.signalLoopCancel('consultation-1', { reason: 'abandoned' });

      expect(harnessGatewayService.signalLoopCancel).toHaveBeenCalledWith('consultation-1', { reason: 'abandoned' });
    });

    it('never throws when the gateway call fails (best-effort)', async () => {
      const { service, harnessGatewayService } = buildDeps('true');
      harnessGatewayService.signalLoopCancel.mockRejectedValue(new Error('harness unreachable'));

      await expect(service.signalLoopCancel('consultation-1', {})).resolves.toBeUndefined();
    });
  });
});
