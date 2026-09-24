/**
 * TASK-1003 — the live-documentation half of the recording lifecycle contract.
 *
 * `recording/stop` now answers once the consultation is DRAINING and drains the live note in the
 * background (F-7 / OD-2). Two things in THIS service make that safe:
 *
 *  1. `stop()` is SINGLE-FLIGHT per consultation. A second stop (a client retry, the shutdown
 *     hook, the loop's `livedoc.stop`) while a drain is running JOINS it — it never starts a
 *     second forced-flush loop over the same session.
 *  2. The live handoff can be marked PENDING before the status leaves RECORDING. The durable
 *     run polls `readLiveHandoff` from consultation open, and it reads `DRAINING` with no record
 *     as "ended with nothing" — so without the marker, a poll landing inside the drain would
 *     finalize the note with nothing bound.
 *
 * And the STT re-bind (F-8 / OD-3, SUPERSEDE): when `start()` re-binds a live session to a
 * DIFFERENT STT session it announces the superseded one exactly once
 * (`STT_SESSION_SUPERSEDED_EVENT`) so the gateway can finalize it through its normal path — this
 * service never cancels or discards it.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { STT_SESSION_SUPERSEDED_EVENT } from '../../consultation/stt-session-superseded.event';

const TENANT = 'tenant-1003';
const CID = 'consultation-1003';
const PENDING_KEY = `live-doc:handoff-pending:${CID}`;
const HANDOFF_KEY = `live-doc:handoff:${CID}`;

type Wiring = { status?: string };

function buildService(wiring: Wiring = {}) {
  const stored = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    exists: vi.fn(async (key: string) => stored.has(key)),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const emitter = { emit: vi.fn() };
  const audioBridge = {
    subscribeToResults: vi.fn(() => ({ subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) })),
    unsubscribeFromResults: vi.fn(),
  };

  const args: unknown[] = new Array(32).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[4] = audioBridge;
  args[15] = {
    findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', status: wiring.status ?? 'DRAINING', metadata: null })),
  };
  // The trailing optional EventEmitter2.
  args[31] = emitter;

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, cache, stored, emitter, audioBridge };
}

type SessionShape = {
  consultationId: string;
  tenantId: string;
  sessionId?: string;
  transcriptParts: string[];
  flushedTranscriptCount: number;
  sttSubscription?: { unsubscribe: () => void };
};

function sessions(service: LiveDocumentationService): Map<string, SessionShape> {
  return (service as unknown as { sessions: Map<string, SessionShape> }).sessions;
}

function seedSession(service: LiveDocumentationService, overrides: Partial<SessionShape> = {}): SessionShape {
  const session: SessionShape = {
    consultationId: CID,
    tenantId: TENANT,
    transcriptParts: ['patient reports cough'],
    flushedTranscriptCount: 0,
    ...overrides,
  };
  sessions(service).set(CID, session as never);
  return session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TASK-1003 — stop() is single-flight per consultation', () => {
  it('a second stop while a drain is running JOINS it and never starts a second drain', async () => {
    const { service } = buildService();
    const session = seedSession(service);
    const gate = deferred<null>();
    const flush = vi.spyOn(service, 'flush').mockImplementation(async () => {
      await gate.promise;
      session.flushedTranscriptCount = session.transcriptParts.length;
      return null;
    });

    const first = service.stop(CID, { persistSnapshot: false });
    const second = service.stop(CID, { persistSnapshot: false });

    expect(second).toBe(first);
    gate.resolve(null);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('a stop AFTER the in-flight one settled runs on its own (the guard is released)', async () => {
    const { service } = buildService();
    seedSession(service);
    vi.spyOn(service, 'flush').mockResolvedValue(null);

    const first = service.stop(CID);
    await first;
    const next = service.stop(CID);

    expect(next).not.toBe(first);
    await expect(next).resolves.toBeNull();
  });

  it('a failing drain rejects every joined caller and still releases the guard', async () => {
    const { service } = buildService();
    seedSession(service);
    vi.spyOn(service, 'flush').mockResolvedValue({ runningSummary: 'S: cough' } as never);
    vi.spyOn(service as unknown as { persistDurableSnapshot: () => Promise<void> }, 'persistDurableSnapshot').mockRejectedValue(new Error('db down'));

    const first = service.stop(CID, { persistSnapshot: true });
    const second = service.stop(CID, { persistSnapshot: true });

    await expect(first).rejects.toThrow('db down');
    await expect(second).rejects.toThrow('db down');
    // Released: the next stop is a run of its own (no snapshot opt-in this time, so it completes).
    const next = service.stop(CID);
    expect(next).not.toBe(first);
    await expect(next).resolves.toEqual({ runningSummary: 'S: cough' });
  });
});

describe('TASK-1003 — a resumed recording waits for the previous stop to finish', () => {
  it('whenStopped() resolves at once when no stop is running', async () => {
    const { service } = buildService();
    seedSession(service);

    await expect(service.whenStopped(CID)).resolves.toBeUndefined();
  });

  it('whenStopped() settles only after the running stop has torn the session down — and never rejects', async () => {
    const { service } = buildService();
    seedSession(service);
    const gate = deferred<null>();
    vi.spyOn(service, 'flush').mockImplementation(async () => gate.promise);

    const draining = service.stop(CID);
    let settled = false;
    const waited = service.whenStopped(CID).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    expect(service.isActive(CID)).toBe(true);

    gate.resolve(null);
    await waited;
    await draining;
    expect(service.isActive(CID)).toBe(false);

    seedSession(service);
    vi.spyOn(service as unknown as { persistLiveHandoff: () => Promise<void> }, 'persistLiveHandoff').mockRejectedValueOnce(new Error('redis down'));
    const failing = service.stop(CID).catch(() => undefined);
    await expect(service.whenStopped(CID)).resolves.toBeUndefined();
    await failing;
  });
});

describe('TASK-1003 — the handoff is PENDING while the stop drains', () => {
  it('marks the handoff pending only when this instance owns the live session', async () => {
    const { service, stored } = buildService();

    await service.markHandoffPending(CID);
    expect(stored.has(PENDING_KEY)).toBe(false);

    seedSession(service);
    await service.markHandoffPending(CID);
    expect(stored.has(PENDING_KEY)).toBe(true);
  });

  it('answers `ended: false` for a DRAINING consultation whose handoff is pending, then hands off once the drain ends', async () => {
    const { service, stored } = buildService({ status: 'DRAINING' });
    seedSession(service);
    const gate = deferred<null>();
    vi.spyOn(service, 'flush').mockImplementation(async () => gate.promise);

    await service.markHandoffPending(CID);
    const draining = service.stop(CID, { persistSnapshot: false });

    await expect(service.readLiveHandoff(CID)).resolves.toEqual({ ended: false, outputs: {}, context: {} });

    gate.resolve(null);
    await draining;

    expect(stored.has(PENDING_KEY)).toBe(false);
    expect(stored.has(HANDOFF_KEY)).toBe(true);
    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: true });
  });

  it('clears the marker even when the drain fails, so the run reads the honest empty instead of waiting', async () => {
    const { service, stored } = buildService({ status: 'DRAINING' });
    seedSession(service);
    vi.spyOn(service, 'flush').mockResolvedValue({ runningSummary: 'S: cough' } as never);
    vi.spyOn(service as unknown as { persistDurableSnapshot: () => Promise<void> }, 'persistDurableSnapshot').mockRejectedValue(new Error('db down'));

    await service.markHandoffPending(CID);
    await expect(service.stop(CID, { persistSnapshot: true })).rejects.toThrow('db down');

    expect(stored.has(PENDING_KEY)).toBe(false);
    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: true, outputs: {} });
  });

  it('a stop on an instance that owns no session never touches another instance’s marker', async () => {
    const { service, stored } = buildService({ status: 'DRAINING' });
    stored.set(PENDING_KEY, 'owner-elsewhere');

    await service.stop(CID);

    expect(stored.get(PENDING_KEY)).toBe('owner-elsewhere');
    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: false });
  });
});

describe('TASK-1003 — re-binding to a different STT session supersedes the old one', () => {
  const start = (service: LiveDocumentationService, sessionId?: string) =>
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', sessionId });

  it('announces the superseded session exactly once, with the pinned payload', () => {
    const { service, emitter } = buildService();
    seedSession(service, { sessionId: 'stt-old', sttSubscription: { unsubscribe: vi.fn() } });

    start(service, 'stt-new');

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(STT_SESSION_SUPERSEDED_EVENT, {
      tenantId: TENANT,
      consultationId: CID,
      supersededSessionId: 'stt-old',
      supersedingSessionId: 'stt-new',
    });
    expect(sessions(service).get(CID)?.sessionId).toBe('stt-new');
  });

  it('the same session id stays a no-op', () => {
    const { service, emitter } = buildService();
    seedSession(service, { sessionId: 'stt-same' });

    start(service, 'stt-same');

    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('binding a session to a live session that had none supersedes nothing', () => {
    const { service, emitter } = buildService();
    seedSession(service);

    start(service, 'stt-first');

    expect(emitter.emit).not.toHaveBeenCalled();
    expect(sessions(service).get(CID)?.sessionId).toBe('stt-first');
  });

  it('a chain of re-binds announces each replaced session once', () => {
    const { service, emitter } = buildService();
    seedSession(service, { sessionId: 'stt-a' });

    start(service, 'stt-b');
    start(service, 'stt-c');

    expect(emitter.emit.mock.calls.map(([, payload]) => [payload.supersededSessionId, payload.supersedingSessionId])).toEqual([
      ['stt-a', 'stt-b'],
      ['stt-b', 'stt-c'],
    ]);
  });

  it('never cancels the superseded STT session itself — it only drops its own subscription', () => {
    const { service, audioBridge } = buildService();
    const unsubscribe = vi.fn();
    seedSession(service, { sessionId: 'stt-old', sttSubscription: { unsubscribe } });

    start(service, 'stt-new');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(audioBridge.unsubscribeFromResults).not.toHaveBeenCalled();
    expect(audioBridge.subscribeToResults).toHaveBeenCalledWith('stt-new');
  });
});
