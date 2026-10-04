/**
 * TASK-1038 B3a deliverable 7 — the consultation job stream fixes.
 *
 * - G6: the browser hook listens for NAMED events (`status`, `progress`, `result`) while the
 *   server sent unnamed frames, so the hook never saw a single update. Every frame is now named
 *   and every frame's data is the full job status, so a name-agnostic parser (vox-node) still
 *   reads the same objects.
 * - G10: a terminal update published between the first status read and the SUBSCRIBE was lost
 *   and the stream hung; the status is re-read after subscribing. An idle stream keeps alive.
 * - G16: `sseUrl` named a path that does not exist.
 * - G14: SUMMARY jobs (harness-owned) are cancellable through the harness; `CANCELED` and
 *   `CANCELLED` are both terminal on read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { ConsultationJobService } from '../consultation-job.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'job-1') }));

function status(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ jobId: 'job-1', type: 'PRE_SUMMARY', status: 'PENDING', consultationId: 'c-1', progress: 0, createdAt: '2026-10-04T00:00:00.000Z', tenantId: 't', userId: 'u', ...overrides });
}

function build(options: { reads?: (string | null)[]; channel?: Subject<string>; harness?: unknown } = {}) {
  const reads = [...(options.reads ?? [status()])];
  const store = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => (key.startsWith('consultation_job:') ? (reads.length > 1 ? reads.shift()! : reads[0]) : (store.get(key) ?? null))),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      if (key.startsWith('consultation_job:')) reads.splice(0, reads.length, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn(),
    eval: vi.fn(),
  };
  const channel = options.channel ?? new Subject<string>();
  const subscriber = { subscribeToChannel: vi.fn(async () => channel.asObservable()) };
  const queue = { add: vi.fn(), getJob: vi.fn().mockResolvedValue(null) };
  const service = new ConsultationJobService(queue as never, cache as never, subscriber as never, options.harness as never);
  return { service, cache, channel, subscriber };
}

function collect(stream: Observable<MessageEvent>) {
  const events: MessageEvent[] = [];
  let completed = false;
  const subscription = stream.subscribe({ next: (event) => events.push(event), complete: () => (completed = true) });
  return { events, isComplete: () => completed, subscription };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('G6 — named frames the browser hook can hear, full status in every frame', () => {
  it('status on connect; progress + status while running; result + status on completion (then complete)', async () => {
    const { service, channel } = build();
    const { events, isComplete } = collect(service.subscribeToJobUpdates('job-1'));
    await flush();
    await flush();
    channel.next(status({ status: 'RUNNING', progress: 40, currentStep: 'Generating' }));
    channel.next(status({ status: 'COMPLETED', progress: 100, result: { contextItemId: 'ci' } }));
    await flush();

    expect(events.map((event) => event.type)).toEqual(['status', 'progress', 'status', 'result', 'status']);
    for (const event of events) expect(JSON.parse(String(event.data))).toHaveProperty('jobId', 'job-1');
    expect(JSON.parse(String(events[1].data)).progress).toBe(40);
    expect(JSON.parse(String(events[3].data)).result).toEqual({ contextItemId: 'ci' });
    expect(isComplete()).toBe(true);
  });
});

describe('G10 — no lost terminal, keep-alive', () => {
  it('re-reads the status after SUBSCRIBE: a terminal published in the gap ends the stream', async () => {
    const { service } = build({ reads: [status({ status: 'RUNNING' }), status({ status: 'COMPLETED', result: { x: 1 } })] });
    const { events, isComplete } = collect(service.subscribeToJobUpdates('job-1'));
    await flush();
    await flush();
    await flush();
    expect(events.at(-1)?.type).toBe('status');
    expect(JSON.parse(String(events.at(-1)?.data)).status).toBe('COMPLETED');
    expect(isComplete()).toBe(true);
  });

  it('sends an SSE comment keep-alive every 15 s while idle', async () => {
    vi.useFakeTimers();
    const { service } = build({ reads: [status({ status: 'RUNNING' })] });
    const { events, subscription } = collect(service.subscribeToJobUpdates('job-1'));
    await vi.advanceTimersByTimeAsync(15_100);
    expect(events.some((event) => (event as MessageEvent & { comment?: string }).comment === 'keepalive')).toBe(true);
    subscription.unsubscribe();
  });

  it('a CANCELED (alias) record is terminal on read', async () => {
    const { service } = build({ reads: [status({ status: 'CANCELED' })] });
    const { isComplete, events } = collect(service.subscribeToJobUpdates('job-1'));
    await flush();
    await flush();
    expect(isComplete()).toBe(true);
    expect(JSON.parse(String(events[0].data)).status).toBe('CANCELLED');
  });
});

describe('G16 — sseUrl names the real stream route', () => {
  it('createPreSummaryJob answers /api/v1/consultations/jobs/:id/stream', async () => {
    const { service } = build();
    const job = await service.createPreSummaryJob('c-1', 't', 'u', {});
    expect(job.sseUrl).toBe('/api/v1/consultations/jobs/job-1/stream');
  });
});

describe('G14 — SUMMARY jobs are cancellable through the harness', () => {
  it('cancels the consultation document workflow and records CANCELLED', async () => {
    const harness = { cancelDocumentWorkflow: vi.fn().mockResolvedValue({}) };
    const { service, cache } = build({ reads: [status({ type: 'SUMMARY', status: 'RUNNING' })], harness });
    await expect(service.cancelJob('job-1')).resolves.toBe(true);
    expect(harness.cancelDocumentWorkflow).toHaveBeenCalledWith('c-1', expect.objectContaining({ tenantId: 't' }));
    expect(JSON.parse(cache.setex.mock.calls.at(-1)![2] as string).status).toBe('CANCELLED');
  });

  it('is not cancellable when no harness is wired, or the harness refuses', async () => {
    expect(await build({ reads: [status({ type: 'SUMMARY', status: 'RUNNING' })] }).service.cancelJob('job-1')).toBe(false);
    const harness = { cancelDocumentWorkflow: vi.fn().mockRejectedValue(new Error('404')) };
    expect(await build({ reads: [status({ type: 'SUMMARY', status: 'RUNNING' })], harness }).service.cancelJob('job-1')).toBe(false);
  });

  it('a terminal job (either spelling) is never cancelled, and a late update never revives a cancelled job', async () => {
    const harness = { cancelDocumentWorkflow: vi.fn() };
    expect(await build({ reads: [status({ type: 'SUMMARY', status: 'CANCELED' })], harness }).service.cancelJob('job-1')).toBe(false);
    const { service, cache } = build({ reads: [status({ status: 'CANCELLED' })] });
    await service.notifyFailed('job-1', 'late');
    await service.notifyProgress('job-1', 50, 'late');
    expect(cache.setex).not.toHaveBeenCalled();
  });
});
