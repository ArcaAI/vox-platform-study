/**
 * TASK-1036 §3.2 — `POST /agents/:slug/speech` with `delivery: 'blob'`.
 *
 * Streaming stays the default and is byte-for-byte unchanged. `delivery: 'blob'` buffers the
 * synthesis, stores it in the tenant bucket (`persistSpeechBlob`) and answers JSON
 * `{ mediaId, url, expiresAt, format, sampleRate, durationMs }`; the usage row is still written.
 */
import 'reflect-metadata';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';
const RESOLVED = {
  agentId: 'a-tts',
  agentVersionId: 'a-tts',
  slug: 'calm-voice',
  versionNumber: 1,
  task: 'TEXT_TO_SPEECH',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: { model: { slug: 'kokoro', provider: 'built-in' }, parameters: { voice: 'af', format: 'pcm' } },
  models: [],
};

function fakeRes() {
  const res = {
    headers: {} as Record<string, string>,
    chunks: [] as Buffer[],
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn((k: string, v: string) => void (res.headers[k] = v)),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: Buffer) => void res.chunks.push(chunk)),
    end: vi.fn(),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => void (res.body = body)),
    on: vi.fn(),
  };
  return res;
}

function make() {
  const audio = Buffer.alloc(32_000); // 1 s of PCM16 mono at 16 kHz
  const post = vi.fn(async () => ({
    headers: {
      'content-type': 'audio/pcm',
      'x-tts-provider': 'kokoro',
      'x-tts-sample-rate': '16000',
      'x-tts-audio-format': 'pcm',
    },
    data: Readable.from([audio.subarray(0, 16_000), audio.subarray(16_000)]),
  }));
  const usageLedger = { recordUsage: vi.fn(async () => ({ written: 1 })) };
  const media = { create: vi.fn(async (request: Record<string, unknown>) => ({ id: 'media-7', ...request })) };
  const blobStorage = { putObject: vi.fn(async () => undefined), presignGet: vi.fn(async () => 'https://signed/url') };
  const tenantBuckets = { getBucketByPurpose: vi.fn(async () => ({ name: 'tenant-audio' })), getBucketBySlug: vi.fn(async () => null) };
  const controller = new AgentController(
    {} as never,
    { resolve: vi.fn(async () => RESOLVED) } as never,
    {
      buildSpeechRequest: vi.fn(() => ({ input: 'Hello there', voice: 'af', model: 'kokoro', response_format: 'pcm' })),
    } as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    { axiosRef: { post } } as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    { assertMeterQuota: vi.fn(async () => undefined) } as never,
    usageLedger as never,
    undefined,
    undefined,
    media as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    tenantBuckets as never,
    blobStorage as never,
    { resolvePlatform: () => ({ value: 300 }) } as never,
  );
  return { controller, post, usageLedger, media, blobStorage, audio };
}

describe('POST /agents/:slug/speech — delivery', () => {
  it('blob: stores the audio and answers { mediaId, url, expiresAt, format, sampleRate, durationMs }', async () => {
    const { controller, blobStorage, media, usageLedger, audio } = make();
    const res = fakeRes();
    await controller.speech('calm-voice', { text: 'Hello there', delivery: 'blob' }, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mediaId: 'media-7', url: 'https://signed/url', format: 'pcm', sampleRate: 16_000, durationMs: 1000 });
    expect(blobStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'tenant-audio', body: audio }));
    expect(media.create).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageLedger.recordUsage).toHaveBeenCalled();
  });

  it('default: still streams the audio, writes no blob', async () => {
    const { controller, blobStorage } = make();
    const res = fakeRes();
    await controller.speech('calm-voice', { text: 'Hello there' }, res as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Buffer.concat(res.chunks).length).toBe(32_000);
    expect(res.headers['Content-Type']).toBe('audio/pcm');
    expect(blobStorage.putObject).not.toHaveBeenCalled();
  });

  it('refuses an unknown delivery with 400', async () => {
    const { controller } = make();
    await expect(controller.speech('calm-voice', { text: 'x', delivery: 'carrier-pigeon' } as never, fakeRes() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
