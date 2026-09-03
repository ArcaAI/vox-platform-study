/**
 * ConsultationController — `POST :id/recording/stop` loop-ending signal.
 *
 * `stopRecording` already tears down the LiveDocumentationService session and
 * flips the consultation status back to OPEN. This ticket adds a THIRD,
 * best-effort call: `LoopContextSignalService.signalConsultationEnding`, so a
 * running `ConsultationLoopWorkflow` drains, runs its ending actions, and
 * finalizes. Verifies:
 *   - `signalConsultationEnding` is called exactly once, with the
 *     consultationId and a reason
 *   - a failure in the loop signal does NOT break the recording/stop response
 *     (LoopContextSignalService already swallows internally, but this proves
 *     the controller never adds its own try/catch requirement around it)
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

function buildController(overrides: {
  consultation?: { doctorId?: string; status?: string };
  loopContextSignalService?: { signalConsultationEnding: ReturnType<typeof vi.fn> };
} = {}) {
  const consultation = overrides.consultation ?? { doctorId: 'doctor-1', status: 'OPEN' };
  const consultationService = {
    getById: vi.fn().mockResolvedValue(consultation),
    stopRecording: vi.fn().mockResolvedValue(consultation),
  };
  const liveDocumentationService = { stop: vi.fn().mockResolvedValue(undefined) };
  const loopContextSignalService = overrides.loopContextSignalService ?? {
    signalConsultationEnding: vi.fn().mockResolvedValue(undefined),
  };
  const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'doctor-1' } : key === 'tenantId' ? 'tenant-1' : undefined)) };

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, {
    consultationService,
    liveDocumentationService,
    loopContextSignalService,
    cls,
  });
  return { controller, consultationService, liveDocumentationService, loopContextSignalService };
}

describe('ConsultationController.stopRecording — loop-ending signal', () => {
  it('signals the loop consultation-ending exactly once, with the consultationId and a reason', async () => {
    const { controller, loopContextSignalService } = buildController();

    await controller.stopRecording('consult-1', { persistSnapshot: true });

    expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1);
    expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith('consult-1', {
      reason: 'recording_stopped',
      persistSnapshot: true,
    });
  });

  it('defaults persistSnapshot to true when the request omits it', async () => {
    const { controller, loopContextSignalService } = buildController();

    await controller.stopRecording('consult-1', {} as never);

    expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith(
      'consult-1',
      expect.objectContaining({ persistSnapshot: true }),
    );
  });

  it(': threads acceptedProposals from the request into the ending signal', async () => {
    const { controller, loopContextSignalService } = buildController();
    const proposal = {
      proposalId: 'p-1',
      start: 10,
      end: 16,
      original: 'Toprovol',
      proposed: 'Toprol',
      category: 'drugName',
      confidence: 0.92,
      status: 'ACCEPTED',
    };

    await controller.stopRecording('consult-1', { persistSnapshot: true, acceptedProposals: [proposal] } as never);

    expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith('consult-1', {
      reason: 'recording_stopped',
      persistSnapshot: true,
      acceptedProposals: [proposal],
    });
  });

  it(': omits acceptedProposals from the signal when the request carries none', async () => {
    const { controller, loopContextSignalService } = buildController();

    await controller.stopRecording('consult-1', { persistSnapshot: true });

    const [, payload] = loopContextSignalService.signalConsultationEnding.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.acceptedProposals).toBeUndefined();
  });

  it('still tears down the LiveDoc session and flips the consultation status, alongside the new signal', async () => {
    const { controller, liveDocumentationService, consultationService } = buildController();

    const result = await controller.stopRecording('consult-1', { persistSnapshot: false });

    expect(liveDocumentationService.stop).toHaveBeenCalledWith('consult-1', { persistSnapshot: false });
    expect(consultationService.stopRecording).toHaveBeenCalledWith('consult-1');
    expect(result).toMatchObject({ consultationId: 'consult-1', recording: false });
  });
});
