/**
 * HarnessProgressService Unit Tests (TASK-345).
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
import { Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { HarnessProgressService } from '../harness-progress.service';
import type { HarnessProgressEventDto } from '../dto';

const CID = 'consult-345';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:harness-progress:${CID}`;
const SNAPSHOT_KEY = `consultation:harness-progress:${CID}:last`;

interface BuildOpts {
  snapshot?: string | null;
}

function buildDeps(opts: BuildOpts = {}) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(opts.snapshot ?? null),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const channelMessages$ = new Subject<string>();
  const redisSubscriber = {
    subscribeToChannel: vi.fn().mockResolvedValue(channelMessages$.asObservable()),
    unsubscribeFromChannel: vi.fn(),
  };

  const service = new HarnessProgressService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cacheService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisSubscriber as any,
  );

  return { service, cacheService, redisSubscriber, channelMessages$ };
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
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'active', attempt: 1, at: '2026-06-10T00:00:00.000Z' },
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

  it('re-activates a re-emitted stage (regen): attempt increments and later stages reset to pending', async () => {
    const prior = snapshotOf([
      { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
      { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
      { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'completed', attempt: 1, at: 't3' },
      { stage: 'running_safety_sensors', label: 'Running safety sensors', ordinal: 4, status: 'active', attempt: 1, at: 't4' },
    ]);
    const { service, cacheService } = buildDeps({ snapshot: prior });

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, total: 5 });

    const event = lastPublished(cacheService);
    const byStage = Object.fromEntries(event.stages.map((s) => [s.stage, s]));
    expect(byStage.extracting_information.status).toBe('completed');
    expect(byStage.assembling_context.status).toBe('completed');
    expect(byStage.drafting_note).toMatchObject({ status: 'active', attempt: 2 });
    expect(byStage.running_safety_sensors.status).toBe('pending');
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

    const live = snapshotOf([{ stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'active', attempt: 1, at: 't2' }]);
    channelMessages$.next(live);
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(live);

    subscription.unsubscribe();
  });

  it('completes after the terminal closed event and unsubscribes from the channel', async () => {
    const { service, redisSubscriber, channelMessages$ } = buildDeps();

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
    channelMessages$.next(closed);

    expect(received).toEqual([closed]);
    expect(completed).toBe(true);
    expect(redisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith(CHANNEL);
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
