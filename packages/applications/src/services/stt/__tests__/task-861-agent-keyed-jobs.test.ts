/**
 * TASK-861 — the three application services on the STT path carry the ASR Agent
 * identity + the resolved spec (TASK-1006: and nothing else — the pipeline path is gone):
 *  - StreamingSessionService forwards `resolved_spec` in the create-session body;
 *  - TranscriptionJobService creates an agent-keyed job, and ONLY an agent-keyed job;
 *  - TranscriptionRealtimeService dispatches `resolved_spec` as a Dramatiq kwarg.
 */
import { BadRequestException } from '@nestjs/common';
import { TranscriptionJobType } from '@arcaai/domains';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streaming/streamingSession.service';
import { TranscriptionJobService } from '../job/transcriptionJob.service';
import { TranscriptionRealtimeService } from '../realtime/transcriptionRealtime.service';

const spec = {
  schemaVersion: 1,
  runtimeKey: 'agent-v-1',
  agent: { slug: 'platform-transcription', versionId: 'agent-v-1' },
  models: { asr: { slug: 'whisper' } },
  audioFrontEnd: { diarization: { enabled: false } },
  fallback: { kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null },
};

describe('StreamingSessionService.createSession — resolved_spec (TASK-861)', () => {
  it('forwards the ResolvedAsrSpec as `resolved_spec` — and no pipeline id beside it', async () => {
    const post = vi.fn(() => of({ data: { session_id: 's1', status: 'active', max_concurrent: 4, current_active: 1, active_engine: 'primary' } }));
    const service = new StreamingSessionService({ post } as never);
    await service.createSession({ sessionId: 's1', tenantId: 't1', resolvedSpec: spec as never });
    const body = (post.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body.resolved_spec).toEqual(spec);
    expect(body).not.toHaveProperty('pipeline_id');
  });
});

describe('TranscriptionJobService.create — agent-keyed jobs (TASK-861)', () => {
  const jobRepository = { create: vi.fn(async (entity: unknown) => entity) };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 't1' : { id: 'u1', tenantId: 't1' })) };
  const make = () => new TranscriptionJobService(jobRepository as never, eventEmitter as never, cls as never);

  beforeEach(() => vi.clearAllMocks());

  it('creates a batch job keyed to the agent version + spec snapshot', async () => {
    const out = await make().createBatchJob({
      agentVersionId: 'agent-v-1',
      resolvedSpec: spec as never,
      mediaId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(out.agentVersionId).toBe('agent-v-1');
    expect(out.resolvedSpec).toEqual(spec);
    expect(out).not.toHaveProperty('pipelineId');
    expect(out.jobType).toBe(TranscriptionJobType.BATCH);
  });

  it('rejects a job keyed to no agent version (400) — there is no other selector', async () => {
    await expect(make().createBatchJob({ mediaId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(jobRepository.create).not.toHaveBeenCalled();
  });

  it('rejects an agentVersionId without its resolvedSpec (the job must be reproducible from its row)', async () => {
    await expect(
      make().createBatchJob({ agentVersionId: 'agent-v-1', mediaId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TranscriptionRealtimeService.dispatchDramatiqJob — resolved_spec kwarg (TASK-861)', () => {
  it('carries the spec as a KWARG (never positional), `None` in the retired pipeline_id slot, and no fallback_pipeline_id', async () => {
    const cache = { hset: vi.fn(), rpush: vi.fn(), publish: vi.fn() };
    const service = new TranscriptionRealtimeService({} as never, {} as never, cache as never);
    await service.dispatchDramatiqJob({ jobId: 'j1', tenantId: 't1', audioUri: 's3://b/k', resolvedSpec: spec as never });
    const encoded = (cache.hset.mock.calls[0] as unknown[])[2] as string;
    const message = JSON.parse(encoded) as { args: unknown[]; kwargs: Record<string, unknown> };
    expect(message.args).toHaveLength(10);
    expect(message.args[2]).toBeNull();
    expect(message.kwargs.resolved_spec).toEqual(spec);
    expect('fallback_pipeline_id' in message.kwargs).toBe(false);
  });
});
