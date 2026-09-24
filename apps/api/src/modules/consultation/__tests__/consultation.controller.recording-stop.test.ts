/**
 * ConsultationController — `POST :id/recording/stop`.
 *
 * The response needs only the DRAINING transition, so the handler answers as soon as that write
 * is persisted (TASK-1003 OD-2). The slow half — draining the live note (which publishes the
 * terminal `closed` frame and writes the live handoff) and then the best-effort loop-ending
 * signal — runs in the background, in that order, and never reaches the response. Verifies:
 *   - the handoff is marked pending BEFORE the status write, so the durable run keeps waiting for
 *     the background drain instead of reading DRAINING as "ended with nothing";
 *   - the handler resolves while the drain is still running, with the same body as before;
 *   - the drain runs before the signal, and a failure in either is logged, never propagated;
 *   - the background work keeps the request's tenant after the response is sent;
 *   - `signalConsultationEnding` still gets the consultationId, the reason and the proposals.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { describe, it, expect, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildController(
  overrides: {
    consultation?: { doctorId?: string; status?: string };
    liveStop?: ReturnType<typeof vi.fn>;
    loopContextSignalService?: { signalConsultationEnding: ReturnType<typeof vi.fn> };
    stopRecording?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const consultation = overrides.consultation ?? { doctorId: 'doctor-1', status: 'DRAINING' };
  const consultationService = {
    getById: vi.fn().mockResolvedValue(consultation),
    stopRecording: overrides.stopRecording ?? vi.fn().mockResolvedValue(consultation),
  };
  const liveDocumentationService = {
    stop: overrides.liveStop ?? vi.fn().mockResolvedValue(null),
    markHandoffPending: vi.fn().mockResolvedValue(undefined),
  };
  const loopContextSignalService = overrides.loopContextSignalService ?? {
    signalConsultationEnding: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const cls = new ClsService(new AsyncLocalStorage());

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, {
    consultationService,
    liveDocumentationService,
    loopContextSignalService,
    cls,
    logger,
  });

  /** Run the handler inside a request-shaped CLS context, the way the CLS middleware does. */
  const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      cls.set('tenantId', 'tenant-1');
      cls.set('user', { id: 'doctor-1' } as never);
      return fn();
    });

  return { controller, consultationService, liveDocumentationService, loopContextSignalService, logger, cls, inRequest };
}

describe('ConsultationController.stopRecording — loop-ending signal', () => {
  it('signals the loop consultation-ending exactly once, with the consultationId and a reason', async () => {
    const { controller, loopContextSignalService, inRequest } = buildController();

    await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true }));

    await vi.waitFor(() => expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1));
    expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith('consult-1', {
      reason: 'recording_stopped',
      persistSnapshot: true,
    });
  });

  it('defaults persistSnapshot to true when the request omits it', async () => {
    const { controller, loopContextSignalService, inRequest } = buildController();

    await inRequest(() => controller.stopRecording('consult-1', {} as never));

    await vi.waitFor(() =>
      expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith('consult-1', expect.objectContaining({ persistSnapshot: true })),
    );
  });

  it(': threads acceptedProposals from the request into the ending signal', async () => {
    const { controller, loopContextSignalService, inRequest } = buildController();
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

    await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true, acceptedProposals: [proposal] } as never));

    await vi.waitFor(() =>
      expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledWith('consult-1', {
        reason: 'recording_stopped',
        persistSnapshot: true,
        acceptedProposals: [proposal],
      }),
    );
  });

  it(': omits acceptedProposals from the signal when the request carries none', async () => {
    const { controller, loopContextSignalService, inRequest } = buildController();

    await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true }));

    await vi.waitFor(() => expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1));
    const [, payload] = loopContextSignalService.signalConsultationEnding.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.acceptedProposals).toBeUndefined();
  });

  it('still tears down the LiveDoc session and flips the consultation status, alongside the signal', async () => {
    const { controller, liveDocumentationService, consultationService, inRequest } = buildController();

    const result = await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: false }));

    await vi.waitFor(() => expect(liveDocumentationService.stop).toHaveBeenCalledWith('consult-1', { persistSnapshot: false }));
    expect(consultationService.stopRecording).toHaveBeenCalledWith('consult-1');
    expect(result).toMatchObject({ consultationId: 'consult-1', recording: false });
  });
});

describe('ConsultationController.stopRecording — answers once DRAINING is persisted (TASK-1003)', () => {
  it('resolves while the live-note drain is still running, with the same body as before', async () => {
    const drain = deferred<null>();
    const { controller, loopContextSignalService, inRequest } = buildController({ liveStop: vi.fn(() => drain.promise) });

    const result = await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true }));

    expect(result).toEqual({
      consultationId: 'consult-1',
      status: 'DRAINING',
      recording: false,
      sseUrl: '/consultations/consult-1/live-summary/stream',
      updatedAt: expect.any(String),
    });
    expect(loopContextSignalService.signalConsultationEnding).not.toHaveBeenCalled();

    drain.resolve(null);
    await vi.waitFor(() => expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1));
  });

  it('marks the handoff pending before the status write, and signals only after the drain settles', async () => {
    const drain = deferred<null>();
    const { controller, consultationService, liveDocumentationService, loopContextSignalService, inRequest } = buildController({
      liveStop: vi.fn(() => drain.promise),
    });

    await inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true }));
    await vi.waitFor(() => expect(liveDocumentationService.stop).toHaveBeenCalledTimes(1));

    const [marked] = liveDocumentationService.markHandoffPending.mock.invocationCallOrder;
    const [transitioned] = consultationService.stopRecording.mock.invocationCallOrder;
    expect(liveDocumentationService.markHandoffPending).toHaveBeenCalledWith('consult-1');
    expect(marked).toBeLessThan(transitioned);

    // The drain is still running: nothing has told the loop to finalize yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loopContextSignalService.signalConsultationEnding).not.toHaveBeenCalled();

    drain.resolve(null);
    await vi.waitFor(() => expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1));
    const [drained] = liveDocumentationService.stop.mock.invocationCallOrder;
    const [signalled] = loopContextSignalService.signalConsultationEnding.mock.invocationCallOrder;
    expect(drained).toBeLessThan(signalled);
  });

  it('a failing drain is logged, never propagated, and the loop is still told the recording stopped', async () => {
    const { controller, loopContextSignalService, logger, inRequest } = buildController({
      liveStop: vi.fn().mockRejectedValue(new Error('TEXT /generate timed out')),
    });

    await expect(inRequest(() => controller.stopRecording('consult-1', { persistSnapshot: true }))).resolves.toMatchObject({ recording: false });

    await vi.waitFor(() => expect(loopContextSignalService.signalConsultationEnding).toHaveBeenCalledTimes(1));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ consultationId: 'consult-1', error: 'TEXT /generate timed out' }));
  });

  it('a failing loop signal is logged, never propagated', async () => {
    const { controller, logger, inRequest } = buildController({
      loopContextSignalService: { signalConsultationEnding: vi.fn().mockRejectedValue(new Error('harness unreachable')) },
    });

    await expect(inRequest(() => controller.stopRecording('consult-1', {}))).resolves.toMatchObject({ recording: false });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ consultationId: 'consult-1', error: 'harness unreachable' })));
  });

  it('a refused status write still stops the live session (as before), sends no signal, and surfaces the error', async () => {
    const { controller, liveDocumentationService, loopContextSignalService, inRequest } = buildController({
      stopRecording: vi.fn().mockRejectedValue(new ConflictException('illegal transition')),
    });

    await expect(inRequest(() => controller.stopRecording('consult-1', {}))).rejects.toThrow(ConflictException);

    await vi.waitFor(() => expect(liveDocumentationService.stop).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loopContextSignalService.signalConsultationEnding).not.toHaveBeenCalled();
  });

  it('the background work keeps the request tenant after the response is sent', async () => {
    const drain = deferred<null>();
    const seen: { drainTenant?: unknown; signalTenant?: unknown } = {};
    const { controller, cls, inRequest } = buildController({
      liveStop: vi.fn(async () => {
        await drain.promise;
        seen.drainTenant = cls.get('tenantId');
        return null;
      }),
      loopContextSignalService: {
        signalConsultationEnding: vi.fn(async () => {
          seen.signalTenant = cls.get('tenantId');
        }),
      },
    });

    await inRequest(async () => {
      await controller.stopRecording('consult-1', {});
      // The request is over. Anything the request's own context does from here on must not
      // reach the work it left running.
      cls.set('tenantId', undefined as never);
    });
    drain.resolve(null);

    await vi.waitFor(() => expect(seen.signalTenant).toBe('tenant-1'));
    expect(seen.drainTenant).toBe('tenant-1');
  });
});
