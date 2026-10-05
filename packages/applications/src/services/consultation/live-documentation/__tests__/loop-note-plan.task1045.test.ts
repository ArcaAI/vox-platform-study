/**
 * TASK-1045 — a consultation finalized by the default agentic LOOP (Substrate A) executes the
 * composed note plan, exactly like one finalized through the harness-doc starter.
 *
 * `LoopContextSignalService.signalConsultationEnding` composes the plan when (and only when) the
 * ending signal will actually be sent, and attaches `notePlanRef`; the harness forwards it onto the
 * loop's finalize child. A plan that cannot fit the model's window, or a model with no declared
 * window, fails the consultation's processing by name and the loop is still ended (without a
 * ref), so it never stays parked. Any other composition failure ends the loop without a ref.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConsultationProcessing } from '@arcaai/domains';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { LoopContextSignalService } from '../../loop/loop-context-signal.service';

const CONSULTATION = 'consultation-1';
const TENANT = 'tenant-1';
const REF = { consultationId: CONSULTATION, mode: 'final' as const, planId: '0199a000-0000-7000-8000-000000000001' };

function build(
  opts: {
    composer?: { composeNotePlan: ReturnType<typeof vi.fn> } | null;
    entitled?: boolean;
    governed?: boolean;
  } = {},
) {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const tenantSettings = new TenantSettingsService({ getValueFromCache: () => null, getTenantValueFromCache: () => null } as never);
  const composer =
    opts.composer === null
      ? undefined
      : (opts.composer ?? {
          composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: REF, strategy: 'single_pass', callCount: 1, promptTokens: 100 }),
        });
  const lifecycleGate = { setProcessing: vi.fn().mockResolvedValue(undefined), currentEncounterSeq: vi.fn() };
  const consultationRepository = {
    findById: vi
      .fn()
      .mockResolvedValue({ metadata: opts.governed ? { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-1' } } : null }),
  };
  const cls = { get: (key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null) };
  const service = new LoopContextSignalService(
    harnessGatewayService as never,
    tenantSettings,
    { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) } as never,
    cls as never,
    consultationRepository as never,
    composer as never,
    lifecycleGate as never,
  );
  return { service, harnessGatewayService, composer, lifecycleGate };
}

describe('LoopContextSignalService.signalConsultationEnding composes the note plan (TASK-1045)', () => {
  it('composes the final plan for the CLS tenant and user, and attaches notePlanRef to the ending signal', async () => {
    const { service, harnessGatewayService, composer } = build();

    await service.signalConsultationEnding(CONSULTATION, { reason: 'recording_stopped', persistSnapshot: true });

    expect(composer!.composeNotePlan).toHaveBeenCalledWith(CONSULTATION, { tenantId: TENANT, userId: 'user-1', mode: 'final' });
    expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith(CONSULTATION, {
      reason: 'recording_stopped',
      persistSnapshot: true,
      notePlanRef: REF,
    });
  });

  it.each(['NOTE_INPUT_EXCEEDS_CONTEXT', 'NOTE_MODEL_CONTEXT_UNDECLARED'])(
    '%s fails processing by name and still ends the loop, without a ref',
    async (code) => {
      const composer = { composeNotePlan: vi.fn().mockRejectedValue(new BadRequestException({ code, message: 'refused' })) };
      const { service, harnessGatewayService, lifecycleGate } = build({ composer });

      await expect(service.signalConsultationEnding(CONSULTATION, { reason: 'recording_stopped' })).resolves.toBeUndefined();

      expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.FAILED, code);
      expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith(CONSULTATION, { reason: 'recording_stopped' });
    },
  );

  it('ends the loop even when the FAILED write itself throws', async () => {
    const composer = { composeNotePlan: vi.fn().mockRejectedValue(new BadRequestException({ code: 'NOTE_INPUT_EXCEEDS_CONTEXT' })) };
    const { service, harnessGatewayService, lifecycleGate } = build({ composer });
    lifecycleGate.setProcessing.mockRejectedValue(new Error('db down'));

    await service.signalConsultationEnding(CONSULTATION, {});

    expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith(CONSULTATION, {});
  });

  it('any other composition failure ends the loop without a ref and fails nothing', async () => {
    const composer = { composeNotePlan: vi.fn().mockRejectedValue(new ServiceUnavailableException({ code: 'NOTE_COMPOSER_UNAVAILABLE' })) };
    const { service, harnessGatewayService, lifecycleGate } = build({ composer });

    await service.signalConsultationEnding(CONSULTATION, { reason: 'recording_stopped' });

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith(CONSULTATION, { reason: 'recording_stopped' });
  });

  it('does not compose when the loop is not signalled (unentitled tenant)', async () => {
    const { service, harnessGatewayService, composer } = build({ entitled: false });

    await service.signalConsultationEnding(CONSULTATION, {});

    expect(composer!.composeNotePlan).not.toHaveBeenCalled();
    expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
  });

  it('does not compose for a governed consultation — the loop is cancelled, not ended', async () => {
    const { service, harnessGatewayService, composer } = build({ governed: true });

    await service.signalConsultationEnding(CONSULTATION, {});

    expect(composer!.composeNotePlan).not.toHaveBeenCalled();
    expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
    expect(harnessGatewayService.signalLoopCancel).toHaveBeenCalled();
  });

  it('without a composer wired the ending signal is sent unchanged', async () => {
    const { service, harnessGatewayService } = build({ composer: null });

    await service.signalConsultationEnding(CONSULTATION, { reason: 'recording_stopped' });

    expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledWith(CONSULTATION, { reason: 'recording_stopped' });
  });
});
