/**
 * TASK-1036 §3.2 — TTS output persisted to the tenant bucket when the caller asks for a BLOB.
 *
 * `POST /agents/:slug/speech` streams audio by default (unchanged). With `delivery: 'blob'` the
 * synthesis is stored in the tenant's AUDIO bucket as a `Media` row and the answer is
 * `{ mediaId, url, expiresAt, format, sampleRate, durationMs }` — the URL short-lived and signed
 * (`workflowRuns.resultUrlTtlSeconds`, the delivery plane's one signed-URL lifetime).
 */
import { describe, expect, it, vi } from 'vitest';
import { persistSpeechBlob, speechDurationMs } from '../tts-blob-delivery';

/** A minimal PCM16 mono WAV of `samples` samples at `rate` Hz. */
function wav(samples: number, rate: number): Buffer {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  return buf;
}

describe('speechDurationMs', () => {
  it('reads a WAV header', () => {
    expect(speechDurationMs(wav(24_000, 24_000), 'wav', null)).toBe(1000);
  });
  it('computes raw PCM16 mono from the sample rate', () => {
    expect(speechDurationMs(Buffer.alloc(48_000), 'pcm', 24_000)).toBe(1000);
  });
  it('does not guess for a compressed format', () => {
    expect(speechDurationMs(Buffer.alloc(1000), 'mp3', 24_000)).toBeNull();
  });
});

function deps(over: Record<string, unknown> = {}) {
  return {
    blobStorage: { putObject: vi.fn(async () => undefined), presignGet: vi.fn(async () => 'https://minio.example/signed?x=1') },
    tenantBuckets: {
      getBucketByPurpose: vi.fn(async () => ({ name: 'tenant-t1-audio' })),
      getBucketBySlug: vi.fn(async () => null),
    },
    media: { create: vi.fn(async (request: Record<string, unknown>) => ({ id: 'media-42', ...request })) },
    settings: { resolvePlatform: vi.fn(() => ({ value: 300 })) },
    ...over,
  };
}

describe('persistSpeechBlob', () => {
  it('stores the audio in the tenant AUDIO bucket, registers a Media row, and signs a short-lived URL', async () => {
    const d = deps();
    const audio = wav(12_000, 24_000);
    const answer = await persistSpeechBlob(d as never, { tenantId: 't1', agentSlug: 'calm-voice', audio, format: 'wav', sampleRate: null, durationMs: null });

    expect(d.blobStorage.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'tenant-t1-audio', key: expect.stringMatching(/\/tts\/calm-voice\/.+\.wav$/), body: audio, contentType: 'audio/wav' }),
    );
    expect(d.media.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', extension: 'wav', mimeType: 'audio/wav', size: audio.length, uri: expect.stringMatching(/^s3:\/\/tenant-t1-audio\//) }),
    );
    expect(d.blobStorage.presignGet).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'tenant-t1-audio', expiresInSeconds: 300 }));
    expect(answer).toMatchObject({ mediaId: 'media-42', url: 'https://minio.example/signed?x=1', format: 'wav', sampleRate: 24_000, durationMs: 500 });
    expect(Date.parse(answer.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('prefers what apps/tts reported (sample rate, duration) over what it can derive', async () => {
    const answer = await persistSpeechBlob(deps() as never, {
      tenantId: 't1',
      agentSlug: 'calm-voice',
      audio: Buffer.alloc(100),
      format: 'mp3',
      sampleRate: 22_050,
      durationMs: 1234,
    });
    expect(answer).toMatchObject({ format: 'mp3', sampleRate: 22_050, durationMs: 1234 });
  });

  it('falls back to the `recordings` bucket slug, and refuses (503) when the tenant has no audio bucket', async () => {
    const fallback = deps({
      tenantBuckets: { getBucketByPurpose: vi.fn(async () => null), getBucketBySlug: vi.fn(async (slug: string) => (slug === 'recordings' ? { name: 'rec' } : null)) },
    });
    await persistSpeechBlob(fallback as never, { tenantId: 't1', agentSlug: 'v', audio: Buffer.alloc(10), format: 'pcm', sampleRate: 16_000, durationMs: null });
    expect(fallback.blobStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'rec' }));

    const none = deps({ tenantBuckets: { getBucketByPurpose: vi.fn(async () => null), getBucketBySlug: vi.fn(async () => null) } });
    await expect(
      persistSpeechBlob(none as never, { tenantId: 't1', agentSlug: 'v', audio: Buffer.alloc(10), format: 'pcm', sampleRate: 16_000, durationMs: null }),
    ).rejects.toMatchObject({ status: 503, response: { code: 'TTS_BLOB_STORAGE_UNAVAILABLE' } });
  });
});
