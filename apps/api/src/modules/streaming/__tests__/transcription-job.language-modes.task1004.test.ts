/**
 * TASK-1004 §4.4 — `GET audio/transcription-jobs/language-modes[?agentSlug=]`: the catalog judged
 * against the caller's ASR agent chain (default: the tenant's resolved agent), with a strong ETag
 * and `If-None-Match` → 304, and `no-transform` so an ingress never weakens the validator.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

const VIEW = {
  catalog: { modes: [{ id: 'ml-en', levels: { WHISPER_CPP: 'degraded' } }], agentSlug: 'platform-transcription', engines: ['WHISPER_CPP'] },
  etag: '"abc123"',
};

function build() {
  const capability = { catalogFor: vi.fn().mockResolvedValue(VIEW) };
  const sessionService = { getLanguageModes: vi.fn().mockResolvedValue({ modes: [] }) };
  const controller = new TranscriptionJobController(
    {} as never,
    {} as never,
    sessionService as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    capability as never,
  );
  return { controller, capability, sessionService };
}

const res = () => {
  const headers: Record<string, string> = {};
  const r = {
    statusCode: 200,
    setHeader: vi.fn((k: string, v: string) => void (headers[k.toLowerCase()] = v)),
    status: vi.fn((c: number) => ((r.statusCode = c), r)),
    headers,
  };
  return r;
};

beforeEach(() => vi.clearAllMocks());

describe('GET language-modes — per agent, ETag, 304', () => {
  it('judges the caller’s default agent (tenant-scoped) and sets a strong, no-transform ETag', async () => {
    const { controller, capability } = build();
    const r = res();
    const body = await controller.getLanguageModes(undefined, undefined, r as never);
    expect(capability.catalogFor).toHaveBeenCalledWith('tenant-1', null);
    expect(body).toEqual(VIEW.catalog);
    expect(r.headers.etag).toBe('"abc123"');
    expect(r.headers['cache-control']).toContain('no-transform');
  });

  it('passes an explicit agentSlug', async () => {
    const { controller, capability } = build();
    await controller.getLanguageModes('sarvam-agent', undefined, res() as never);
    expect(capability.catalogFor).toHaveBeenCalledWith('tenant-1', 'sarvam-agent');
  });

  it('If-None-Match (strong or weak) that matches → 304 with no body', async () => {
    for (const header of ['"abc123"', 'W/"abc123"', '"zzz", "abc123"']) {
      const { controller } = build();
      const r = res();
      const body = await controller.getLanguageModes(undefined, header, r as never);
      expect(r.status).toHaveBeenCalledWith(304);
      expect(body).toBeUndefined();
    }
  });

  it('a stale If-None-Match gets the full catalog', async () => {
    const { controller } = build();
    const r = res();
    expect(await controller.getLanguageModes(undefined, '"old"', r as never)).toEqual(VIEW.catalog);
    expect(r.status).not.toHaveBeenCalled();
  });

  it('a malformed agentSlug is 400 before any resolution', async () => {
    const { controller, capability } = build();
    await expect(controller.getLanguageModes('../etc', undefined, res() as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(capability.catalogFor).not.toHaveBeenCalled();
  });
});
