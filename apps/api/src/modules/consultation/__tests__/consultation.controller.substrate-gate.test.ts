/**
 * task 13 — `POST :id/recording/start` and the substrate gate.
 *
 * ## What this pins, and what it deliberately does NOT
 *
 * The gate itself lives in `LiveDocumentationService.start()`, not here. That is
 * the correct layer: a controller holds no business logic, and resolving the
 * governing-engine marker is a row read the service already owns (its sibling
 * `LoopContextSignalService` does the same for the loop plane). Putting the read
 * in the controller would have made a second copy of a fail-open decision whose
 * whole value is that there is one.
 *
 * What the CONTROLLER must guarantee is narrower and still worth pinning: that
 * it delegates every recording start to that gated entry point, with the
 * consultation's own identity, and that it does not acquire a second path into
 * the engine. Before the same call existed with nothing behind it
 * `startRecording` called `start()` after only an ownership and status check
 * ( The call site is unchanged; what changed is that `start()`
 * now answers "may I document this consultation?" before it does anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

function buildController(overrides: { doctorId?: string; tenantId?: string } = {}) {
  const consultation = { id: 'consult-1', doctorId: overrides.doctorId ?? 'doctor-1', status: 'RECORDING' };
  const consultationService = {
    getById: vi.fn().mockResolvedValue(consultation),
    startRecording: vi.fn().mockResolvedValue(consultation),
  };
  const liveDocumentationService = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
  const cls = {
    get: vi.fn((key: string) =>
      key === 'user' ? { id: overrides.doctorId ?? 'doctor-1' } : key === 'tenantId' ? (overrides.tenantId ?? 'tenant-1') : undefined,
    ),
  };

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, { consultationService, liveDocumentationService, cls });
  return { controller, consultationService, liveDocumentationService };
}

describe('ConsultationController.startRecording — the gated entry point', () => {
  it('routes every recording start through the GATED `start()`, exactly once', async () => {
    const { controller, liveDocumentationService } = buildController();

    await controller.startRecording('consult-1', { sessionId: 'stt-1' });

    expect(liveDocumentationService.start).toHaveBeenCalledTimes(1);
  });

  it('hands the gate the identity it needs to resolve the governing substrate', async () => {
    const { controller, liveDocumentationService } = buildController({ tenantId: 'tenant-42', doctorId: 'doctor-9' });

    await controller.startRecording('consult-1', { sessionId: 'stt-1' });

    // The consultationId is what `ensureSubstrateResolved` reads the
    // governing-engine marker off; without it the gate cannot resolve at all.
    expect(liveDocumentationService.start).toHaveBeenCalledWith({
      consultationId: 'consult-1',
      tenantId: 'tenant-42',
      userId: 'doctor-9',
      sessionId: 'stt-1',
    });
  });

  it('starts the recording BEFORE the engine, so a rejected start never spins a watcher up', async () => {
    const { controller, consultationService, liveDocumentationService } = buildController();
    consultationService.startRecording.mockRejectedValueOnce(new Error('not in a startable state'));

    await expect(controller.startRecording('consult-1', { sessionId: 'stt-1' })).rejects.toThrow('not in a startable state');

    expect(liveDocumentationService.start).not.toHaveBeenCalled();
  });

  it('has exactly ONE path into the engine — the response advertises the stream, it does not open a second one', async () => {
    const { controller, liveDocumentationService } = buildController();

    const response = await controller.startRecording('consult-1', { sessionId: 'stt-1' });

    expect(response.sseUrl).toBe('/consultations/consult-1/live-summary/stream');
    expect(Object.keys(liveDocumentationService).filter((k) => liveDocumentationService[k as 'start'].mock.calls.length > 0)).toEqual(['start']);
  });
});
