import { EventEmitter } from 'node:events';

import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeechProxyController } from '../speech-proxy.controller';

const createMockHttpService = () => ({ axiosRef: { post: vi.fn(), get: vi.fn() } });

const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => (key === 'TTS_URL' ? 'http://localhost:8865' : undefined)),
});

const createMockSecrets = (token?: string) => ({ getSecretSync: vi.fn(() => token) });

function makeStream() {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  return stream;
}

function makeRes() {
  const headers: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    headersSent: false,
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
  };
  return res;
}

describe('SpeechProxyController', () => {
  let controller: SpeechProxyController;
  let http: ReturnType<typeof createMockHttpService>;
  let config: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    http = createMockHttpService();
    config = createMockConfigService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller = new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET /speech/voices', () => {
    it('proxies to TTS /api/v1/voices with the service token and returns data', async () => {
      http.axiosRef.get.mockResolvedValue({ data: { voices: [{ id: 'en-female-1' }] } });
      const result = await controller.voices();
      expect(result).toEqual({ voices: [{ id: 'en-female-1' }] });
      expect(http.axiosRef.get).toHaveBeenCalledWith(
        'http://localhost:8865/api/v1/voices',
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Token': 'svc-token' }) }),
      );
    });

    it('maps an upstream error to an HttpException with the upstream status', async () => {
      http.axiosRef.get.mockRejectedValue({ response: { status: 503, data: 'boom' } });
      await expect(controller.voices()).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('POST /speech/synthesize', () => {
    it('streams upstream audio to the response with the right headers and body', async () => {
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: stream });
      const res = makeRes();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      expect(http.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8865/api/v1/audio/speech',
        { input: 'Hi.', voice: 'en-female-1' },
        expect.objectContaining({
          responseType: 'stream',
          headers: expect.objectContaining({ 'X-Service-Token': 'svc-token' }),
        }),
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/pcm');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, no-transform');
      expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
      expect(res.flushHeaders).toHaveBeenCalled();

      stream.emit('data', Buffer.from('AB'));
      stream.emit('end');
      expect(res.write).toHaveBeenCalledTimes(1);
      expect(res.end).toHaveBeenCalled();
    });

    it('omits X-Service-Token when no secret is available (dev fail-open)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller = new SpeechProxyController(http as any, config as any, createMockSecrets(undefined) as any);
      http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      const callHeaders = http.axiosRef.post.mock.calls[0][2].headers;
      expect(callHeaders['X-Service-Token']).toBeUndefined();
    });

    it('returns a generic status and never forwards the upstream body (PHI safety)', async () => {
      http.axiosRef.post.mockRejectedValue({ response: { status: 503, data: { detail: 'internal prompt echo' } } });
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ detail: 'TTS service unavailable' });
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'internal prompt echo' }));
    });

    it('retries a connect-phase failure then streams on success', async () => {
      vi.useFakeTimers();
      const stream = makeStream();
      http.axiosRef.post
        .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
        .mockResolvedValueOnce({ headers: { 'content-type': 'audio/pcm' }, data: stream });
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      await vi.runAllTimersAsync();
      await pending;
      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
      expect(res.flushHeaders).toHaveBeenCalled();
    });

    it('does NOT retry when the upstream responded (request was delivered)', async () => {
      http.axiosRef.post.mockRejectedValue({ response: { status: 500, data: '' } });
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
