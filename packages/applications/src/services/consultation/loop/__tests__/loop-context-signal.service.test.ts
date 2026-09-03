/**
 * LoopContextSignalService Unit Tests — PAYLOAD, IDEMPOTENCE, BEST-EFFORT.
 *
 * The @OnEvent(ContextAdded) consumer that signals `ConsultationLoopWorkflow`
 * via `HarnessGatewayService.signalContextAdded`.
 *
 * SCOPE SPLIT. The GATE moved out of this file. Whether a signal is
 * allowed at all is now a composition of the tenant's `agenticLoop` subscription
 * entitlement and the `harness.loop.emergencyStop` platform veto, pinned in
 * `./loop-entitlement-gate.test.ts`; the setting-TIER properties (runtime flip,
 * disarmed default, failMode) stay in
 * `../../__tests__/consultation-gates.tier-compliance.test.ts`. What is left
 * here is everything that happens AFTER the gate says yes, so every fixture
 * below is deliberately fully permitted: entitled tenant, no emergency.
 *
 * Covers:
 *   - the exact outbound payload shape
 *   - idempotent under duplicate emission (same consultationId + contextItemId
 *     + timestamp signals exactly once)
 *   - a fresh emission for the SAME contextItemId (e.g. OCR re-emit with new
 *     content — different timestamp) is NOT treated as a duplicate
 *   - never throws when the gateway call fails (best-effort)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { LoopContextSignalService } from '../loop-context-signal.service';
import type { ContextAddedPayload } from '../../events';

/** A fully-permitted service: entitled tenant, no emergency stop stored. */
function buildDeps() {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const appSettings = {
    // No stored row for `harness.loop.emergencyStop` — its disarmed default answers.
    getValueFromCache: () => null,
    getTenantValueFromCache: () => null,
  };
  const tenantSettings = new TenantSettingsService(appSettings as any);
  const service = new LoopContextSignalService(
    harnessGatewayService as any,
    tenantSettings,
    { isFeatureEnabled: vi.fn(async () => true) } as any,
    { get: (key: string) => (key === 'tenantId' ? 'tenant-1' : null) } as any,
  );
  return { service, harnessGatewayService, tenantSettings };
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

  it('signals the harness gateway with the full outbound payload', async () => {
    const { service, harnessGatewayService } = buildDeps();

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

  // Payload completeness: kindKey/occurredAt/depth/content now
  // ride the outbound signal.
  it('forwards kindKey, occurredAt (the payload timestamp), depth, and the fuller content field', async () => {
    const { service, harnessGatewayService } = buildDeps();

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
    const { service, harnessGatewayService } = buildDeps();

    await service.handleContextAdded(payload({ depth: undefined }));

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith(
      'consultation-1',
      expect.objectContaining({ depth: 0 }),
    );
  });

  it('is idempotent under duplicate emission (identical payload signals exactly once)', async () => {
    const { service, harnessGatewayService } = buildDeps();
    const event = payload();

    await service.handleContextAdded(event);
    await service.handleContextAdded(event);
    await service.handleContextAdded({ ...event });

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
  });

  it('signals again for a re-emission of the SAME contextItemId carrying a new timestamp (OCR enrichment re-emit — not a duplicate)', async () => {
    const { service, harnessGatewayService } = buildDeps();

    await service.handleContextAdded(payload({ timestamp: '2026-08-11T10:00:00.000Z', contentPreview: 'placeholder' }));
    await service.handleContextAdded(payload({ timestamp: '2026-08-11T10:00:05.000Z', contentPreview: 'OCR text' }));

    expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(2);
  });

  it('never throws when the gateway call fails (best-effort — the context-add path must not break)', async () => {
    const { service, harnessGatewayService } = buildDeps();
    harnessGatewayService.signalContextAdded.mockRejectedValue(new Error('harness unreachable'));

    await expect(service.handleContextAdded(payload())).resolves.toBeUndefined();
  });

  // The two lifecycle-boundary signal callers.
  describe('signalConsultationEnding', () => {
    it('forwards the payload to the harness gateway', async () => {
      const { service, harnessGatewayService } = buildDeps();

      await service.signalConsultationEnding('consultation-1', { reason: 'recording_stopped', persistSnapshot: true });

      expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith('consultation-1', {
        reason: 'recording_stopped',
        persistSnapshot: true,
      });
    });

    it('never throws when the gateway call fails (best-effort)', async () => {
      const { service, harnessGatewayService } = buildDeps();
      harnessGatewayService.signalConsultationEnding.mockRejectedValue(new Error('harness unreachable'));

      await expect(service.signalConsultationEnding('consultation-1', {})).resolves.toBeUndefined();
    });
  });

  describe('signalLoopCancel', () => {
    it('forwards the payload to the harness gateway', async () => {
      const { service, harnessGatewayService } = buildDeps();

      await service.signalLoopCancel('consultation-1', { reason: 'abandoned' });

      expect(harnessGatewayService.signalLoopCancel).toHaveBeenCalledWith('consultation-1', { reason: 'abandoned' });
    });

    it('never throws when the gateway call fails (best-effort)', async () => {
      const { service, harnessGatewayService } = buildDeps();
      harnessGatewayService.signalLoopCancel.mockRejectedValue(new Error('harness unreachable'));

      await expect(service.signalLoopCancel('consultation-1', {})).resolves.toBeUndefined();
    });
  });
});
