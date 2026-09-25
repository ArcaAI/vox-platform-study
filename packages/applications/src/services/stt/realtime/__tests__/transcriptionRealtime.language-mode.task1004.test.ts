/**
 * TASK-1004 D-9 — the batch message carries the job's effective spoken-language mode as two NAMED
 * kwargs (`language_mode`, `language_mode_source`), never positionally: the actor's positional
 * arity is unchanged, so a message already queued by an older gateway stays valid, and a retry
 * re-publishes exactly the mode the first attempt carried (snapshotted in the dispatch envelope).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionRealtimeService } from '../transcriptionRealtime.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'test-uuid-1234') }));

const SPEC = { runtimeKey: 'agent-v-1', models: { asr: { slug: 'whisper' } }, audioFrontEnd: { diarization: { enabled: false } } } as never;
const BASE = { jobId: 'job-1', tenantId: 'tenant-1', resolvedSpec: SPEC, audioUri: 's3://recordings/a.wav', consultationId: 'c-1' };

function build(envelope: Record<string, unknown> | null = null) {
  const cache = { hset: vi.fn().mockResolvedValue(undefined), rpush: vi.fn().mockResolvedValue(1), publish: vi.fn().mockResolvedValue(undefined) };
  const jobService = {
    recordDispatchEnvelope: vi.fn().mockResolvedValue(undefined),
    getDispatchContextForOwner: vi.fn().mockResolvedValue({ envelope, resolvedSpec: SPEC, tenantId: 'tenant-1' }),
    retryJobForOwner: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    failJob: vi.fn(),
  };
  const service = new TranscriptionRealtimeService({ subscribeToChannel: vi.fn() } as never, jobService as never, cache as never);
  return { service, cache, jobService };
}

const published = (cache: { hset: ReturnType<typeof vi.fn> }, call = 0) => JSON.parse(cache.hset.mock.calls[call][2]);

beforeEach(() => vi.clearAllMocks());

describe('dispatchDramatiqJob — language_mode kwargs', () => {
  it('sends language_mode + language_mode_source as kwargs; positional arity is unchanged (10)', async () => {
    const { service, cache } = build();
    await service.dispatchDramatiqJob({ ...BASE, languageMode: 'ml-en', languageModeSource: 'consultation' });
    const message = published(cache);
    expect(message.args).toHaveLength(10);
    expect(message.kwargs).toMatchObject({ language_mode: 'ml-en', language_mode_source: 'consultation' });
  });

  it('sends neither kwarg when no mode was resolved (STT applies the agent’s own)', async () => {
    const { service, cache } = build();
    await service.dispatchDramatiqJob(BASE);
    expect(published(cache).kwargs).not.toHaveProperty('language_mode');
    expect(published(cache).kwargs).not.toHaveProperty('language_mode_source');
  });

  it('snapshots the mode in the dispatch envelope', async () => {
    const { service, jobService } = build();
    await service.dispatchDramatiqJob({ ...BASE, languageMode: 'en', languageModeSource: 'request' });
    expect(jobService.recordDispatchEnvelope).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ languageMode: 'en', languageModeSource: 'request' }),
    );
  });

  it('a retry re-publishes the mode the first attempt carried', async () => {
    const { service, cache } = build({
      audioUri: BASE.audioUri,
      languageMode: 'ml-en',
      languageModeSource: 'consultation',
      hadStorageDescriptor: false,
    });
    await service.retryAndDispatch('job-1', { ownerId: 'u-1' });
    expect(published(cache).kwargs).toMatchObject({ language_mode: 'ml-en', language_mode_source: 'consultation' });
  });
});
