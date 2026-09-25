/**
 * TASK-1006 — the gateway → `apps/stt` wire carries no pipeline any more (cross-lane contract with
 * L-ASR-STT):
 *
 *   - the streaming session-create body sends NEITHER `pipeline_id` NOR `fallback_pipeline_id` —
 *     the session runs on `resolved_spec`, which carries its own fallback chain;
 *   - the Dramatiq `transcribe_file` message keeps its positional ARITY (10), so a message already
 *     queued by an older gateway stays valid, but the old `pipeline_id` slot (index 2) is `None`
 *     and no `fallback_pipeline_id` kwarg is ever sent;
 *   - a job with no `resolvedSpec` — i.e. one created on the retired pipeline path — can no longer
 *     be dispatched: a retry refuses it (409) instead of re-publishing a pipeline pointer nobody
 *     reads.
 */
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAsrSpec } from '@arcaai/types';
import { StreamingSessionService } from '../streaming/streamingSession.service';
import { TranscriptionRealtimeService } from '../realtime/transcriptionRealtime.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'test-uuid-1234') }));

const SPEC = {
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1', versionNumber: 1 },
  models: { asr: { slug: 'whisper-large-v3-turbo', provider: 'self-hosted' } },
  audioFrontEnd: { diarization: { enabled: false } },
  fallback: { kind: 'none', spec: null },
} as unknown as ResolvedAsrSpec;

beforeEach(() => vi.clearAllMocks());

describe('streaming session create body', () => {
  it('sends resolved_spec and no pipeline_id / fallback_pipeline_id', async () => {
    const httpService = {
      post: vi.fn().mockReturnValue(of({ data: { session_id: 's-1', status: 'active', max_concurrent: 4, current_active: 1 } })),
    };
    const service = new StreamingSessionService(httpService as never, { config: { STT_URL: 'http://stt' } } as never);

    await service.createSession({ sessionId: 's-1', tenantId: 't-1', resolvedSpec: SPEC } as never);

    const body = httpService.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.resolved_spec).toEqual(SPEC);
    expect(body).not.toHaveProperty('pipeline_id');
    expect(body).not.toHaveProperty('fallback_pipeline_id');
  });

  it('never reads a pipeline echo off the STT response', async () => {
    const httpService = {
      post: vi
        .fn()
        .mockReturnValue(of({ data: { session_id: 's-1', status: 'active', max_concurrent: 4, current_active: 1, pipeline_id: 'legacy' } })),
    };
    const service = new StreamingSessionService(httpService as never, { config: { STT_URL: 'http://stt' } } as never);

    const status = await service.createSession({ sessionId: 's-1', tenantId: 't-1', resolvedSpec: SPEC } as never);

    expect(status).not.toHaveProperty('pipelineId');
  });
});

describe('Dramatiq transcribe_file message', () => {
  function build(context: { envelope: Record<string, unknown> | null; resolvedSpec: unknown }) {
    const cache = { hset: vi.fn().mockResolvedValue(undefined), rpush: vi.fn().mockResolvedValue(1), publish: vi.fn().mockResolvedValue(undefined) };
    const jobService = {
      recordDispatchEnvelope: vi.fn().mockResolvedValue(undefined),
      getDispatchContextForOwner: vi.fn().mockResolvedValue({ ...context, tenantId: 't-1' }),
      retryJobForOwner: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
      failJob: vi.fn(),
    };
    const service = new TranscriptionRealtimeService({ subscribeToChannel: vi.fn() } as never, jobService as never, cache as never);
    return { service, cache, jobService };
  }
  const published = (cache: { hset: ReturnType<typeof vi.fn> }) => JSON.parse(cache.hset.mock.calls[0][2]);

  it('keeps the positional arity (10) with None in the old pipeline_id slot, and sends no fallback_pipeline_id kwarg', async () => {
    const { service, cache } = build({ envelope: null, resolvedSpec: null });

    await service.dispatchDramatiqJob({ jobId: 'job-1', tenantId: 't-1', audioUri: 's3://recordings/a.wav', resolvedSpec: SPEC });

    const message = published(cache);
    expect(message.args).toHaveLength(10);
    expect(message.args[2]).toBeNull();
    expect(message.kwargs.resolved_spec).toEqual(SPEC);
    expect(message.kwargs).not.toHaveProperty('fallback_pipeline_id');
  });

  it('the retry envelope records no pipeline pointer', async () => {
    const { service, jobService } = build({ envelope: null, resolvedSpec: null });

    await service.dispatchDramatiqJob({ jobId: 'job-1', tenantId: 't-1', audioUri: 's3://recordings/a.wav', resolvedSpec: SPEC });

    const envelope = jobService.recordDispatchEnvelope.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope).not.toHaveProperty('pipelineId');
    expect(envelope).not.toHaveProperty('fallbackPipelineId');
  });

  it('a retry of a job with no resolved spec (the retired pipeline path) is refused, nothing is re-published', async () => {
    const { service, cache, jobService } = build({
      envelope: { audioUri: 's3://recordings/a.wav', pipelineId: 'legacy-pipe', hadStorageDescriptor: false },
      resolvedSpec: null,
    });

    await expect(service.retryAndDispatch('job-1', { ownerId: 'u-1' })).rejects.toMatchObject({ status: 409 });
    expect(jobService.retryJobForOwner).not.toHaveBeenCalled();
    expect(cache.hset).not.toHaveBeenCalled();
  });

  it('a retry of an agent-keyed job re-publishes on its own spec snapshot', async () => {
    const { service, cache } = build({ envelope: { audioUri: 's3://recordings/a.wav', hadStorageDescriptor: false }, resolvedSpec: SPEC });

    await service.retryAndDispatch('job-1', { ownerId: 'u-1' });

    const message = published(cache);
    expect(message.args[2]).toBeNull();
    expect(message.kwargs.resolved_spec).toEqual(SPEC);
  });
});
