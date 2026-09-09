/**
 * HarnessProgressService Unit Tests.
 *
 * The ephemeral harness progress feed: the durable workflow POSTs one stage
 * event at a time; the service folds it into the accumulated full-state
 * snapshot (Redis, 1h TTL) and publishes that full state on
 * `consultation:harness-progress:{consultationId}` for the SSE relay.
 *
 * Covers:
 *   - fold: first event, stage advance, regen re-activation, terminal close
 *   - resilience: corrupt snapshot starts fresh; Redis failure → { ok: false }
 *   - SSE relay: snapshot replay first, channel messages relayed, terminal
 *     `closed: true` completes the stream and unsubscribes
 */
import { describe, it, expect, vi } from 'vitest';
import { Subject, finalize } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { HarnessProgressService } from '../harness-progress.service';
import type { HarnessProgressEventDto } from '../dto';

const CID = 'consult-345';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:harness-progress:${CID}`;
const SNAPSHOT_KEY = `consultation:harness-progress:${CID}:last`;

interface FakeRedisSubscriber {
  subscribeToChannel: ReturnType<typeof vi.fn>;
  unsubscribeFromChannel: ReturnType<typeof vi.fn>;
}

interface BuildOpts {
  snapshot?: string | null;
  redisSubscriber?: FakeRedisSubscriber;
}

function buildDeps(opts: BuildOpts = {}) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(opts.snapshot ?? null),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const channelMessages$ = new Subject<string>();
  const redisSubscriber: FakeRedisSubscriber = opts.redisSubscriber ?? {
    subscribeToChannel: vi.fn().mockResolvedValue(channelMessages$.asObservable()),
    unsubscribeFromChannel: vi.fn(),
  };

  const service = new HarnessProgressService(cacheService as any, redisSubscriber as any);

  return { service, cacheService, redisSubscriber, channelMessages$ };
}

/**
 * Fake mirroring RedisSubscriberService's refcounting contract (MAJ-3):
 * observers of one channel share a Subject; each observable returned by
 * subscribeToChannel decrements the count on unsubscribe and the channel is
 * torn down only when the LAST observer leaves. unsubscribeFromChannel
 * force-completes the shared Subject for everyone — the exact foot-gun an
 * explicit per-viewer call would pull.
 */
function buildRefcountedSubscriber() {
  const channels = new Map<string, Subject<string>>();
  const refCounts = new Map<string, number>();

  const fake = {
    subscribeToChannel: vi.fn(async (channel: string) => {
      if (!channels.has(channel)) {
        channels.set(channel, new Subject<string>());
        refCounts.set(channel, 0);
      }
      refCounts.set(channel, (refCounts.get(channel) ?? 0) + 1);
      return channels
        .get(channel)!
        .asObservable()
        .pipe(
          finalize(() => {
            const next = (refCounts.get(channel) ?? 1) - 1;
            if (next <= 0) fake.unsubscribeFromChannel(channel);
            else refCounts.set(channel, next);
          }),
        );
    }),
    unsubscribeFromChannel: vi.fn((channel: string) => {
      channels.get(channel)?.complete();
      channels.delete(channel);
      refCounts.delete(channel);
    }),
    publish(channel: string, message: string) {
      channels.get(channel)?.next(message);
    },
    hasChannel(channel: string) {
      return channels.has(channel);
    },
  };
  return fake;
}

function lastPublished(cacheService: { publish: ReturnType<typeof vi.fn> }): HarnessProgressEventDto {
  const calls = cacheService.publish.mock.calls;
  return JSON.parse(calls[calls.length - 1][1] as string) as HarnessProgressEventDto;
}

/** A prior snapshot as the service itself would have stored it. */
function snapshotOf(stages: Array<Partial<HarnessProgressEventDto['stages'][number]>>, extra: Partial<HarnessProgressEventDto> = {}): string {
  return JSON.stringify({
    consultationId: CID,
    jobId: 'harness-doc-1',
    total: 5,
    stages,
    updatedAt: '2026-06-10T00:00:00.000Z',
    closed: false,
    ...extra,
  });
}

describe('HarnessProgressService — reportProgress folding', () => {
  it('publishes the full state with the first stage active and stores the identical snapshot (1h TTL)', async () => {
    const { service, cacheService } = buildDeps();

    const ack = await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-1',
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      total: 5,
    });

    expect(ack).toEqual({ ok: true });
    expect(cacheService.setex).toHaveBeenCalledWith(SNAPSHOT_KEY, 3600, expect.any(String));
    expect(cacheService.publish).toHaveBeenCalledWith(CHANNEL, expect.any(String));
    // Snapshot and published message are the same full state.
    expect(cacheService.setex.mock.calls[0][2]).toBe(cacheService.publish.mock.calls[0][1]);

    const event = lastPublished(cacheService);
    expect(event.consultationId).toBe(CID);
    expect(event.jobId).toBe('harness-doc-1');
    expect(event.total).toBe(5);
    expect(event.closed).toBe(false);
    expect(event.stages).toHaveLength(1);
    expect(event.stages[0]).toMatchObject({
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      status: 'active',
      attempt: 1,
    });
    expect(typeof event.stages[0].at).toBe('string');
    expect(typeof event.updatedAt).toBe('string');
  });

  it('folds an advancing stage: prior stages complete, the new one becomes active', async () => {
    const prior = snapshotOf([
      {
        stage: 'extracting_information',
        label: 'Extracting key information',
        ordinal: 1,
        status: 'active',
        attempt: 1,
        at: '2026-06-10T00:00:00.000Z',
      },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'assembling_context', label: 'Assembling context', ordinal: 2, total: 5 });

    const event = lastPublished(cacheService);
    expect(event.stages).toHaveLength(2);
    expect(event.stages[0]).toMatchObject({ stage: 'extracting_information', status: 'completed' });
    expect(event.stages[1]).toMatchObject({ stage: 'assembling_context', status: 'active', attempt: 1 });
    // jobId from the prior snapshot is retained even when the event omits it.
    expect(event.jobId).toBe('harness-doc-1');
  });

  it('re-activates a re-emission of the CURRENT active stage (regen): attempt increments', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
      { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
      { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'completed', attempt: 1, at: 't3' },
      { stage: 'running_safety_sensors', label: 'Running safety sensors', ordinal: 4, status: 'active', attempt: 1, at: 't4' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'running_safety_sensors', label: 'Running safety sensors', ordinal: 4, total: 5 });

    const event = lastPublished(cacheService);
    const byStage = Object.fromEntries(event.stages.map((s) => [s.stage, s]));
    expect(byStage.extracting_information.status).toBe('completed');
    expect(byStage.assembling_context.status).toBe('completed');
    expect(byStage.drafting_note.status).toBe('completed');
    expect(byStage.running_safety_sensors).toMatchObject({ status: 'active', attempt: 2 });
  });

  it('ignores a stale re-delivery of an EARLIER stage: no state regression, no publish', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
      { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
      { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 1, at: 't3' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    // A slow stage-2 HTTP request landing after stage 3 was folded must not
    // rewind the checklist (lost-update flicker).
    const ack = await service.reportProgress(CID, {
      tenantId: TENANT,
      stage: 'assembling_context',
      label: 'Assembling context',
      ordinal: 2,
      total: 5,
    });

    expect(ack).toEqual({ ok: true });
    expect(cacheService.setex).not.toHaveBeenCalled();
    expect(cacheService.publish).not.toHaveBeenCalled();
  });

  it('ignores a late non-terminal event after the feed closed for the same run', async () => {
    const prior = snapshotOf(
      [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'finalizing_draft', label: 'Finalizing the draft', ordinal: 5, status: 'completed', attempt: 1, at: 't5' },
      ],
      { closed: true },
    );
    const { service, cacheService } = buildDeps({ snapshot: prior });

    const ack = await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-1',
      stage: 'finalizing_draft',
      label: 'Finalizing the draft',
      ordinal: 5,
      total: 5,
    });

    expect(ack).toEqual({ ok: true });
    expect(cacheService.publish).not.toHaveBeenCalled();
  });

  it('discards the prior snapshot when the event carries a different jobId: fresh run renders fresh', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 3, at: 't1' },
      { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
      { stage: 'finalizing_draft', label: 'Finalizing the draft', ordinal: 5, status: 'active', attempt: 1, at: 't5' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-2', // a NEW harness run within the snapshot TTL
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      total: 5,
    });

    const event = lastPublished(cacheService);
    expect(event.jobId).toBe('harness-doc-2');
    // No inherited stages, no inherited attempt counter ("pass 2" lie).
    expect(event.stages).toHaveLength(1);
    expect(event.stages[0]).toMatchObject({ stage: 'extracting_information', status: 'active', attempt: 1 });
    expect(event.closed).toBe(false);
  });

  it('a new jobId also reopens a feed previously closed by a terminal event', async () => {
    const prior = snapshotOf([{ stage: 'finalizing_draft', label: 'Finalizing the draft', ordinal: 5, status: 'completed', attempt: 1, at: 't5' }], {
      closed: true,
    });
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-2',
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      total: 5,
    });

    const event = lastPublished(cacheService);
    expect(event.closed).toBe(false);
    expect(event.stages).toHaveLength(1);
    expect(event.stages[0]).toMatchObject({ stage: 'extracting_information', status: 'active', attempt: 1 });
  });

  it('terminal `failed` event marks the active stage failed, freezes the rest, and closes the feed', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
      { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
      { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 2, at: 't3' },
      { stage: 'running_safety_sensors', label: 'Running safety sensors', ordinal: 4, status: 'pending', attempt: 1, at: 't4' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    const ack = await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-1',
      stage: 'failed',
      label: 'Documentation generation failed',
      ordinal: 5,
      total: 5,
    });

    expect(ack).toEqual({ ok: true });
    const event = lastPublished(cacheService);
    expect(event.closed).toBe(true);
    const byStage = Object.fromEntries(event.stages.map((s) => [s.stage, s]));
    expect(byStage.extracting_information.status).toBe('completed');
    expect(byStage.assembling_context.status).toBe('completed');
    expect(byStage.drafting_note.status).toBe('failed');
    expect(byStage.running_safety_sensors.status).toBe('pending');
    // `failed` is a pseudo-stage — never appended as a checklist entry.
    expect(event.stages).toHaveLength(4);
    expect(event.stages.some((s) => s.stage === 'failed')).toBe(false);
  });

  it('terminal `failed` with no prior snapshot still publishes a closed event (late failure, empty feed)', async () => {
    const { service, cacheService } = buildDeps();

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'failed', label: 'Documentation generation failed', ordinal: 5, total: 5 });

    const event = lastPublished(cacheService);
    expect(event.closed).toBe(true);
    expect(event.stages).toHaveLength(0);
  });

  it('caps stages growth: an unseen stage beyond the cap is ignored', async () => {
    const bloated = snapshotOf(
      Array.from({ length: 50 }, (_, i) => ({
        stage: `stage_${i}`,
        label: `Stage ${i}`,
        ordinal: i + 1,
        status: i === 49 ? ('active' as const) : ('completed' as const),
        attempt: 1,
        at: 't',
      })),
    );
    const { service, cacheService } = buildDeps({ snapshot: bloated });

    const ack = await service.reportProgress(CID, { tenantId: TENANT, stage: 'stage_overflow', label: 'Overflow', ordinal: 51, total: 5 });

    expect(ack).toEqual({ ok: true });
    expect(cacheService.publish).not.toHaveBeenCalled();
  });

  it('folds tenantId into the published event (accepted AND used)', async () => {
    const { service, cacheService } = buildDeps();

    await service.reportProgress(CID, {
      tenantId: TENANT,
      jobId: 'harness-doc-1',
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      total: 5,
    });

    expect(lastPublished(cacheService).tenantId).toBe(TENANT);
  });

  it('terminal `completed` event marks every stage completed and closes the feed without adding an entry', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
      { stage: 'finalizing_draft', label: 'Finalizing the draft', ordinal: 5, status: 'active', attempt: 1, at: 't5' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'completed', label: 'Draft ready for review' });

    const event = lastPublished(cacheService);
    expect(event.closed).toBe(true);
    expect(event.stages).toHaveLength(2);
    expect(event.stages.every((s) => s.status === 'completed')).toBe(true);
    expect(event.stages.some((s) => s.stage === 'completed')).toBe(false);
  });

  // The shape the interpreter's jobId-less finalize publishes (`harness-internal.service.ts`
  // persistDraft step 4): a bare terminal stage, no prior snapshot, no jobId. It must close the
  // feed WITHOUT inventing a checklist the interpreter never emitted — `useHarnessProgressStream`
  // reads `closed` and an empty `stages` as "the harness is done here".
  it('a stage-only terminal publish with no prior state folds to closed with no stages', async () => {
    const { service, cacheService } = buildDeps({ snapshot: null });

    const ack = await service.reportProgress(CID, { tenantId: TENANT, stage: 'completed' });

    expect(ack).toEqual({ ok: true });
    const event = lastPublished(cacheService);
    expect(event.closed).toBe(true);
    expect(event.stages).toEqual([]);
    expect(event.consultationId).toBe(CID);
    expect(event.tenantId).toBe(TENANT);
    expect(event.jobId).toBeUndefined();
  });

  it('starts fresh when the stored snapshot is corrupt (never throws)', async () => {
    const { service, cacheService } = buildDeps({ snapshot: 'not-json{{{' });

    const ack = await service.reportProgress(CID, { tenantId: TENANT, stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, total: 5 });

    expect(ack).toEqual({ ok: true });
    const event = lastPublished(cacheService);
    expect(event.stages).toHaveLength(1);
    expect(event.stages[0]).toMatchObject({ stage: 'drafting_note', status: 'active', attempt: 1 });
  });

  it('resolves { ok: false } (never throws) when Redis publish fails', async () => {
    const { service, cacheService } = buildDeps();
    cacheService.publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.reportProgress(CID, { tenantId: TENANT, stage: 'drafting_note', ordinal: 3 })).resolves.toEqual({ ok: false });
  });
});

describe('HarnessProgressService — SSE relay', () => {
  async function flushAsync(): Promise<void> {
    // Let the snapshot-get + channel-subscribe promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('emits the stored snapshot first, then relays channel messages verbatim', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'active', attempt: 1, at: 't1' },
    ]);
    const { service, redisSubscriber, channelMessages$ } = buildDeps({ snapshot: prior });

    const received: string[] = [];
    const subscription = service.subscribeToProgress(CID).subscribe((event: MessageEvent) => received.push(event.data as string));
    await flushAsync();

    expect(redisSubscriber.subscribeToChannel).toHaveBeenCalledWith(CHANNEL);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(prior);

    // A later fold always carries a later updatedAt (the dedupe filter drops
    // only events at-or-before the snapshot's timestamp).
    const live = snapshotOf([{ stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'active', attempt: 1, at: 't2' }], {
      updatedAt: '2026-06-10T00:00:05.000Z',
    });
    channelMessages$.next(live);
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(live);

    subscription.unsubscribe();
  });

  it('completes after the terminal closed event and tears the channel down via refcount', async () => {
    const refcounted = buildRefcountedSubscriber();
    const { service } = buildDeps({ redisSubscriber: refcounted });

    const received: string[] = [];
    let completed = false;
    service.subscribeToProgress(CID).subscribe({
      next: (event: MessageEvent) => received.push(event.data as string),
      complete: () => {
        completed = true;
      },
    });
    await flushAsync();

    const closed = snapshotOf([], { closed: true });
    refcounted.publish(CHANNEL, closed);

    expect(received).toEqual([closed]);
    expect(completed).toBe(true);
    // Last observer gone -> the refcount finalize released the channel.
    expect(refcounted.hasChannel(CHANNEL)).toBe(false);
  });

  it('keeps a second concurrent viewer streaming after the first disconnects', async () => {
    const refcounted = buildRefcountedSubscriber();
    const { service } = buildDeps({ redisSubscriber: refcounted });

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    let completedB = false;
    const subA = service.subscribeToProgress(CID).subscribe((event: MessageEvent) => receivedA.push(event.data as string));
    const subB = service.subscribeToProgress(CID).subscribe({
      next: (event: MessageEvent) => receivedB.push(event.data as string),
      complete: () => {
        completedB = true;
      },
    });
    await flushAsync();

    // First viewer disconnects (tab closed) — the SHARED channel must survive.
    subA.unsubscribe();

    const live = snapshotOf([{ stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 1, at: 't3' }]);
    refcounted.publish(CHANNEL, live);

    expect(receivedA).toHaveLength(0);
    expect(completedB).toBe(false);
    expect(receivedB).toEqual([live]);

    // Only when the LAST viewer leaves is the channel released.
    expect(refcounted.hasChannel(CHANNEL)).toBe(true);
    subB.unsubscribe();
    expect(refcounted.hasChannel(CHANNEL)).toBe(false);
  });

  it('subscribes to the channel BEFORE reading the snapshot so gap events are not lost', async () => {
    const refcounted = buildRefcountedSubscriber();
    const { service, cacheService } = buildDeps({ redisSubscriber: refcounted });
    let resolveSnapshot!: (value: string | null) => void;
    cacheService.get.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const received: string[] = [];
    service.subscribeToProgress(CID).subscribe((event: MessageEvent) => received.push(event.data as string));
    await flushAsync();

    // The Redis SUBSCRIBE must already be in place while the snapshot read
    // is still in flight.
    expect(refcounted.subscribeToChannel).toHaveBeenCalledWith(CHANNEL);

    const snapshot = snapshotOf(
      [{ stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'active', attempt: 1, at: 't1' }],
      { updatedAt: '2026-06-10T00:00:01.000Z' },
    );
    const gapEvent = snapshotOf([{ stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'active', attempt: 1, at: 't2' }], {
      updatedAt: '2026-06-10T00:00:02.000Z',
    });
    // Published in the snapshot-read window — the old snapshot-then-subscribe
    // order dropped this on the floor.
    refcounted.publish(CHANNEL, gapEvent);
    resolveSnapshot(snapshot);
    await flushAsync();

    expect(received).toEqual([snapshot, gapEvent]);
  });

  it('de-dupes a gap event the snapshot already contains (same updatedAt)', async () => {
    const refcounted = buildRefcountedSubscriber();
    const { service, cacheService } = buildDeps({ redisSubscriber: refcounted });
    let resolveSnapshot!: (value: string | null) => void;
    cacheService.get.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const received: string[] = [];
    service.subscribeToProgress(CID).subscribe((event: MessageEvent) => received.push(event.data as string));
    await flushAsync();

    // reportProgress stores the snapshot BEFORE publishing, so an event
    // published in the gap can be the exact state the snapshot read returns.
    const state = snapshotOf(
      [{ stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'active', attempt: 1, at: 't1' }],
      { updatedAt: '2026-06-10T00:00:03.000Z' },
    );
    refcounted.publish(CHANNEL, state);
    resolveSnapshot(state);
    await flushAsync();

    expect(received).toEqual([state]);
  });

  it('emits an error payload and completes when the relay cannot be initialised', async () => {
    const { service, cacheService } = buildDeps();
    cacheService.get.mockRejectedValueOnce(new Error('redis down'));

    const received: string[] = [];
    let completed = false;
    service.subscribeToProgress(CID).subscribe({
      next: (event: MessageEvent) => received.push(event.data as string),
      complete: () => {
        completed = true;
      },
    });
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toMatchObject({ error: expect.any(String), consultationId: CID });
    expect(completed).toBe(true);
  });
});
