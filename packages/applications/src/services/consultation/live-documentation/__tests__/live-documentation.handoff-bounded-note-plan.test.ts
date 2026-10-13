/**
 * The live-handoff read answers promptly while the note plan is still composing.
 *
 * Measured on the cluster under three concurrent sessions: the first post-stop read of
 * `GET internal/harness/consultations/:id/live-handoff` held its request open for 33–62 s, because
 * it composed the note plan inline and composition waits (2 s polls, up to the platform ledger
 * wait) for each encounter's fact ledger — an LLM job that lands 20–60 s after the stop under load.
 * The harness client gives up at 30 s, so every stop's first poll ended in a ReadTimeout and the
 * finalizer started ~45 s late.
 *
 * Contract: the read waits for an in-flight composition only for a bounded time, well below the
 * harness client timeout; past that it answers `ended: false` with a declared `pendingReason`, the
 * composition keeps running and remembers its plan on the handoff record, and the next poll is
 * answered from the record without composing again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_HANDOFF_NOTE_PLAN_WAIT_MS, LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-handoff-bound';
const CID = 'consultation-handoff-bound';
const REF = { consultationId: CID, mode: 'final' as const, planId: '0199a000-0000-7000-8000-0000000000bb' };
const RECORD = { endedAt: '2026-10-13T04:21:00.000Z', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildService(composeNotePlan: ReturnType<typeof vi.fn>) {
  const stored = new Map<string, string>([[`live-doc:handoff:${CID}`, JSON.stringify(RECORD)]]);
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    exists: vi.fn(async (key: string) => stored.has(key)),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  const args: unknown[] = new Array(34).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', departmentId: null, status: 'STOPPED', metadata: null })),
  };
  args[32] = { composeNotePlan };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, stored };
}

describe('readLiveHandoff — bounded wait for the note plan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds the wait well below the harness client timeout (30 s)', () => {
    expect(LIVE_HANDOFF_NOTE_PLAN_WAIT_MS).toBeGreaterThan(0);
    expect(LIVE_HANDOFF_NOTE_PLAN_WAIT_MS).toBeLessThanOrEqual(15_000);
  });

  it('answers ended:false with a declared reason when composition outlasts the bound, then serves the remembered plan', async () => {
    const slow = deferred<{ notePlanRef: typeof REF; strategy: string; callCount: number }>();
    const composeNotePlan = vi.fn().mockReturnValue(slow.promise);
    const { service, stored } = buildService(composeNotePlan);

    const first = service.readLiveHandoff(CID, ['n_summary']);
    await vi.advanceTimersByTimeAsync(LIVE_HANDOFF_NOTE_PLAN_WAIT_MS);

    await expect(first).resolves.toEqual({ ended: false, outputs: {}, context: {}, pendingReason: 'NOTE_PLAN_COMPOSING' });

    // A poll while still composing joins the in-flight composition — never a second one.
    const second = service.readLiveHandoff(CID, ['n_summary']);
    await vi.advanceTimersByTimeAsync(LIVE_HANDOFF_NOTE_PLAN_WAIT_MS);
    await expect(second).resolves.toMatchObject({ ended: false, pendingReason: 'NOTE_PLAN_COMPOSING' });
    expect(composeNotePlan).toHaveBeenCalledTimes(1);

    // The background composition finishes and remembers its plan on the handoff record …
    slow.resolve({ notePlanRef: REF, strategy: 'single_pass', callCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!).notePlanRef).toEqual(REF);

    // … so the next poll answers ended:true at once, without composing again.
    const third = await service.readLiveHandoff(CID, ['n_summary']);
    expect(third.ended).toBe(true);
    expect(third.outputs).toEqual({ n_summary: { text: '', note_plan_ref: REF } });
    expect(composeNotePlan).toHaveBeenCalledTimes(1);
  });

  it('a composition that finishes inside the bound is answered in the same read', async () => {
    const composeNotePlan = vi.fn().mockResolvedValue({ notePlanRef: REF, strategy: 'single_pass', callCount: 1 });
    const { service } = buildService(composeNotePlan);

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.ended).toBe(true);
    expect(answer.outputs).toEqual({ n_summary: { text: '', note_plan_ref: REF } });
  });

  it('a background composition that later fails is logged, not an unhandled rejection, and the next read composes again', async () => {
    const slow = deferred<never>();
    const composeNotePlan = vi
      .fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ notePlanRef: REF, strategy: 'single_pass', callCount: 1 });
    const { service } = buildService(composeNotePlan);

    const first = service.readLiveHandoff(CID, ['n_summary']);
    await vi.advanceTimersByTimeAsync(LIVE_HANDOFF_NOTE_PLAN_WAIT_MS);
    await expect(first).resolves.toMatchObject({ ended: false, pendingReason: 'NOTE_PLAN_COMPOSING' });

    slow.reject(new Error('text service unavailable'));
    await vi.advanceTimersByTimeAsync(0);

    const again = await service.readLiveHandoff(CID, ['n_summary']);
    expect(again.ended).toBe(true);
    expect(composeNotePlan).toHaveBeenCalledTimes(2);
  });
});
