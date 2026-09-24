/**
 * TASK-1003 — two controller contracts beside `recording/stop`.
 *
 * `recording/start` (F-8 / OD-3, SUPERSEDE): a start naming a different STT session supersedes the
 * previous one. Live documentation re-binds, and announces the superseded session, itself when
 * this process holds the consultation's live session; only when it does not does the controller
 * ask the service to supersede by the DURABLE binding. Asking both would announce one session
 * twice.
 *
 * A resume that lands while the previous stop is still draining in the background waits for that
 * drain: the drain ends by tearing the live session down and publishing `closed`, which must not
 * take the resumed recording with it.
 *
 * `summary/latest` (F-11): the 404 for "no summary yet" stays a 404, but now says so in a
 * machine-readable way — `code: SUMMARY_NOT_READY` plus the progress stream a client can wait on —
 * so a client can tell "not ready" from a missing or foreign consultation (still the plain 404).
 */
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

function buildController(opts: { liveSessionHeld?: boolean; consultation?: unknown; whenStopped?: ReturnType<typeof vi.fn> } = {}) {
  const consultation = opts.consultation === undefined ? { id: 'consult-1', doctorId: 'doctor-1', status: 'RECORDING' } : opts.consultation;
  const consultationService = {
    getById: vi.fn().mockResolvedValue(consultation),
    startRecording: vi.fn().mockResolvedValue(consultation),
  };
  const liveDocumentationService = {
    start: vi.fn(),
    isActive: vi.fn().mockReturnValue(opts.liveSessionHeld ?? false),
    whenStopped: opts.whenStopped ?? vi.fn().mockResolvedValue(undefined),
  };
  const summaryService = { getLatestSummary: vi.fn().mockResolvedValue(null) };
  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'doctor-1' } : key === 'tenantId' ? 'tenant-1' : undefined)),
  };

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, { consultationService, liveDocumentationService, summaryService, cls });
  return { controller, consultationService, liveDocumentationService, summaryService };
}

describe('ConsultationController.startRecording — who supersedes the previous STT session', () => {
  it('asks the service to supersede by the durable binding when no live session is held here', async () => {
    const { controller, consultationService, liveDocumentationService } = buildController({ liveSessionHeld: false });

    await controller.startRecording('consult-1', { sessionId: 'stt-new' });

    expect(liveDocumentationService.isActive).toHaveBeenCalledWith('consult-1');
    expect(consultationService.startRecording).toHaveBeenCalledWith('consult-1', { sttSessionId: 'stt-new', supersedeByDurableBinding: true });
  });

  it('leaves it to the live re-bind when this process holds the live session', async () => {
    const { controller, consultationService, liveDocumentationService } = buildController({ liveSessionHeld: true });

    await controller.startRecording('consult-1', { sessionId: 'stt-new' });

    expect(consultationService.startRecording).toHaveBeenCalledWith('consult-1', { sttSessionId: 'stt-new', supersedeByDurableBinding: false });
    expect(liveDocumentationService.start).toHaveBeenCalledWith(expect.objectContaining({ consultationId: 'consult-1', sessionId: 'stt-new' }));
  });
});

describe('ConsultationController.startRecording — a resume waits for the previous stop to finish', () => {
  it('does not start (or re-bind) anything until the previous stop’s background drain has settled', async () => {
    let release!: () => void;
    const whenStopped = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { controller, consultationService, liveDocumentationService } = buildController({ whenStopped });

    const started = controller.startRecording('consult-1', { sessionId: 'stt-resume' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(whenStopped).toHaveBeenCalledWith('consult-1');
    expect(consultationService.startRecording).not.toHaveBeenCalled();
    expect(liveDocumentationService.start).not.toHaveBeenCalled();

    release();
    await started;
    expect(consultationService.startRecording).toHaveBeenCalledTimes(1);
    expect(liveDocumentationService.start).toHaveBeenCalledTimes(1);
  });
});

describe('ConsultationController.getLatestSummary — "not ready" is a coded 404', () => {
  it('carries code SUMMARY_NOT_READY and the progress stream to wait on', async () => {
    const { controller } = buildController();

    const error = await controller.getLatestSummary('consult-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect((error as NotFoundException).getResponse()).toEqual({
      code: 'SUMMARY_NOT_READY',
      message: expect.stringContaining('consult-1'),
      progressStreamPath: '/api/v1/consultations/consult-1/harness-progress/stream',
    });
  });

  it('a missing consultation is still the plain 404, with no readiness code', async () => {
    const { controller } = buildController({ consultation: null });

    const error = await controller.getLatestSummary('consult-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify((error as NotFoundException).getResponse())).not.toContain('SUMMARY_NOT_READY');
  });

  it('returns the summary unchanged once one exists', async () => {
    const { controller, summaryService } = buildController();
    summaryService.getLatestSummary.mockResolvedValue({ id: 'summary-1' });

    await expect(controller.getLatestSummary('consult-1')).resolves.toEqual({ id: 'summary-1' });
  });
});
