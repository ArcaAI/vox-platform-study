/**
 * TASK-1038 B3a deliverable 6 — the ASR transcription start (`POST audio/transcription-jobs/
 * transcribe`) honours `Idempotency-Key`: the same key with the same upload (file bytes + fields)
 * is the same job — no second upload, job row or worker dispatch — and a different upload under
 * the same key is a 409. Without a key, every call starts a job, as before.
 */
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JobIdempotencyService } from '@arcaai/applications';
import { TranscriptionJobController } from '../transcription-job.controller';

function memoryCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
    eval: vi.fn(async (_s: string, _n: number, key: string, value: string) => {
      if (store.has(String(key))) return store.get(String(key));
      store.set(String(key), String(value));
      return null;
    }),
  };
}

const file = (bytes: string) => ({ buffer: Buffer.from(bytes), mimetype: 'audio/wav', originalname: 'a.wav', size: bytes.length }) as never;

function build() {
  const controller = Object.create(TranscriptionJobController.prototype) as TranscriptionJobController;
  let n = 0;
  const once = vi.fn(async () => ({ id: `job-${++n}`, status: 'QUEUED', sseUrl: '/x', audioUri: 's3://b/k', agentSlug: 'asr', agentVersionId: 'v' }));
  Object.assign(controller, {
    cls: { get: vi.fn((key: string) => (key === 'tenantId' ? 't-1' : key === 'user' ? { id: 'u-1' } : undefined)) },
    jobIdempotency: new JobIdempotencyService(memoryCache() as never),
    transcribeFileOnce: once,
  });
  return { controller, once };
}

describe('POST transcribe — Idempotency-Key', () => {
  it('same key + same upload ⇒ the same job, started once', async () => {
    const { controller, once } = build();
    const a = await controller.transcribeFile(file('RIFF-1'), { language: 'en' } as never, undefined, 'k-1');
    const b = await controller.transcribeFile(file('RIFF-1'), { language: 'en' } as never, undefined, 'k-1');
    expect(b.id).toBe(a.id);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('same key + different audio ⇒ 409', async () => {
    const { controller } = build();
    await controller.transcribeFile(file('RIFF-1'), {} as never, undefined, 'k-1');
    await expect(controller.transcribeFile(file('RIFF-2'), {} as never, undefined, 'k-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('no key ⇒ a job per call', async () => {
    const { controller, once } = build();
    await controller.transcribeFile(file('RIFF-1'), {} as never);
    await controller.transcribeFile(file('RIFF-1'), {} as never);
    expect(once).toHaveBeenCalledTimes(2);
  });
});
