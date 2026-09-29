/**
 * TASK-1004 — a WORKFLOW run's batch transcription (`POST internal/harness/stt/batch-jobs`) carries
 * the consultation's effective spoken-language mode. The workflow node names only the agent; the
 * mode is the request's (`languageMode` > `language`) else the consultation's declared one, sent to
 * the worker as the `language_mode` / `language_mode_source` kwargs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscriptionJobStatus } from '@arcaai/domains';
import { HarnessInternalController } from '../harness-internal.controller';

function makeCls() {
  const store = new Map<string, unknown>();
  return { run: async (fn: () => unknown) => fn(), set: (k: string, v: unknown) => store.set(k, v), get: (k: string) => store.get(k) };
}

describe('HarnessInternalController — stt/batch-jobs language (TASK-1004)', () => {
  let controller: HarnessInternalController;
  let realtimeService: { dispatchDramatiqJob: ReturnType<typeof vi.fn> };
  let consultationService: { getById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    realtimeService = { dispatchDramatiqJob: vi.fn().mockResolvedValue(undefined) };
    consultationService = { getById: vi.fn().mockResolvedValue({ id: 'c-1', language: 'ml-en' }) };
    const jobService = {
      createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', mediaId: 'media-1', status: TranscriptionJobStatus.QUEUED }),
      getById: vi.fn(),
      getByConsultation: vi.fn().mockResolvedValue([]),
    };
    const none = undefined as any;
    controller = new HarnessInternalController(
      none,
      none,
      makeCls() as any,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      jobService as any,
      realtimeService as any,
      consultationService as any,
      { resolve: vi.fn().mockResolvedValue({ spec: { runtimeKey: 'agent-v-1', agent: { slug: 'a-1', versionId: 'agent-v-1' } } }) } as any, // asrResolver
    );
  });

  const dispatched = () => realtimeService.dispatchDramatiqJob.mock.calls[0]![0] as Record<string, unknown>;

  it('no language on the request → inherits the consultation’s declared mode (source consultation)', async () => {
    await controller.createSttBatchJob({ tenantId: 't-1', agentSlug: 'a-1', audioUri: 's3://b/k.wav', consultationId: 'c-1' } as any);
    expect(consultationService.getById).toHaveBeenCalledWith('c-1');
    expect(dispatched()).toMatchObject({ languageMode: 'ml-en', languageModeSource: 'consultation' });
  });

  it('an explicit languageMode wins and the consultation is not read for it', async () => {
    await controller.createSttBatchJob({
      tenantId: 't-1',
      agentSlug: 'a-1',
      audioUri: 's3://b/k.wav',
      consultationId: 'c-1',
      languageMode: 'en',
    } as any);
    expect(consultationService.getById).not.toHaveBeenCalled();
    expect(dispatched()).toMatchObject({ languageMode: 'en', languageModeSource: 'request' });
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN before any job is created', async () => {
    await expect(
      controller.createSttBatchJob({ tenantId: 't-1', agentSlug: 'a-1', audioUri: 's3://b/k.wav', languageMode: 'xx' } as any),
    ).rejects.toMatchObject({ response: { code: 'LANGUAGE_MODE_UNKNOWN' } });
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('an undeclared consultation sends no mode', async () => {
    consultationService.getById.mockResolvedValue({ id: 'c-1' });
    await controller.createSttBatchJob({ tenantId: 't-1', agentSlug: 'a-1', audioUri: 's3://b/k.wav', consultationId: 'c-1' } as any);
    expect(dispatched()).not.toHaveProperty('languageMode');
  });
});
