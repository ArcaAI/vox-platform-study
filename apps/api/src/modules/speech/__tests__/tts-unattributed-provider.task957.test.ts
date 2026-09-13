/**
 * TASK-957 F-10 — a TTS row nobody can attribute is SKIPPED, not guessed.
 *
 * `apps/tts` always sends `X-Tts-Provider`, and when it could not name the engine that served it
 * sends its own sentinel, `"none"` (`tts/core/usage.py:23`, stamped at
 * `api/endpoints/speech.py:184`). All four gateway readers took a missing or sentinel header and
 * wrote a row anyway: `provider: 'none'`, `deployment: SELF_HOSTED`. Both halves are fabrications
 * with money attached —
 *
 *  · `'none'` is a provider id that is not in `KNOWN_PROVIDERS` and matches no price-book row, so
 *    the row rates at zero COGS while still consuming the tenant's CHARACTER allowance first;
 *  · `SELF_HOSTED` asserts the platform's own hardware ran it, which is the one claim the
 *    evidence cannot support — the service declined to say what ran it.
 *
 * A row that cannot be attributed is metered work with no defensible economics behind it, and
 * under-recording is the correctable direction (the audio bytes and the synthesis are both
 * reconstructible; a wrong deployment on an invoice is not). So: no row, a warn carrying the
 * request id, and the `hope_usage_emission_failed_total` counter — the same signal a THROWN
 * emission raises, because both are metered work that was not billed.
 */
import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { USAGE_EMISSION_FAILED_METRIC } from '@arcaai/applications';
import { register } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HarnessTtsInternalController } from '../harness-tts-internal.controller';
import { SpeechProxyController } from '../speech-proxy.controller';
import { TtsWsGateway } from '../tts-ws.gateway';

/** The sentinel `apps/tts` sends when it cannot name the engine that served. */
const UNKNOWN = 'none';

async function emissionFailures(): Promise<number> {
  const metric = register.getSingleMetric(USAGE_EMISSION_FAILED_METRIC);
  if (!metric) return 0;
  const { values } = (await metric.get()) as { values: { labels: Record<string, string>; value: number }[] };
  return values.filter((v) => v.labels.operation === 'tts.synthesize' && v.labels.reason === 'unattributable').reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

// ── 1. the REST synthesize proxy ─────────────────────────────────────────────

const makeStream = () => {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  return stream;
};

function makeRes() {
  const emitter = new EventEmitter();
  const res: Record<string, unknown> = {
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb)),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    status: vi.fn(() => res),
    json: vi.fn(),
  };
  return res;
}

function buildProxy() {
  const http = { axiosRef: { post: vi.fn(), get: vi.fn() } };
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) };
  const controller = new SpeechProxyController(
    http as never,
    { getConfigValue: vi.fn(() => 'http://tts') } as never,
    { getSecretSync: vi.fn(() => 'svc') } as never,
    undefined,
    { get: vi.fn((key: string) => (key === 'tenantId' ? 't1' : undefined)) } as never,
    ledger as never,
    { assertMeterQuota: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { controller, http, ledger };
}

async function runProxy(headers: Record<string, string>) {
  const harness = buildProxy();
  const stream = makeStream();
  harness.http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/wav', ...headers }, data: stream });
  const res = makeRes();
  await harness.controller.synthesize({ input: 'Hello', voice: 'v1' } as never, res as never);
  stream.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  return harness;
}

describe('F-10 · SpeechProxyController', () => {
  it('records the row as before when the service named a provider', async () => {
    const { ledger } = await runProxy({ 'x-tts-provider': 'kokoro', 'x-tts-audio-seconds': '1.5' });
    expect(ledger.recordUsage).toHaveBeenCalledTimes(1);
    expect(ledger.recordUsage.mock.calls[0][0].common.provider).toBe('kokoro');
  });

  it('records NOTHING, warns and counts when the header is absent', async () => {
    const before = await emissionFailures();
    const { ledger } = await runProxy({ 'x-tts-audio-seconds': '1.5' });
    expect(ledger.recordUsage).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(await emissionFailures()).toBe(before + 1);
  });

  it('treats the `none` sentinel exactly like an absent header', async () => {
    const { ledger } = await runProxy({ 'x-tts-provider': UNKNOWN, 'x-tts-audio-seconds': '1.5' });
    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });
});

// ── 2. the harness-internal synthesize controller ────────────────────────────

const AUDIO = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEpayload')]);
const AGENT = { slug: 'clinic-voice', versionId: 'a1', versionNumber: 2, tenantId: 'tenant-a', source: 'tenant' };
const SPEC = {
  schemaVersion: 1,
  agent: AGENT,
  primary: {
    kind: 'primary',
    runtimeKey: 'a1',
    agent: AGENT,
    model: { role: 'primary', slug: 'azure-neural-voices', taskType: 'TEXT_TO_SPEECH', provider: 'azure', voices: [], artifacts: {} },
    parameters: { voice: null, language: 'en', speed: null, format: null, sampleRate: null, ssml: false },
    voice: null,
    connection: { provider: 'azure', funding: 'tenant' },
    fundingTier: 'tenant',
  },
  fallback: { autoSwitch: true, chain: [] },
};

async function runHarness(headers: Record<string, string>) {
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) };
  const store: Record<string, unknown> = {};
  const controller = new HarnessTtsInternalController(
    {
      axiosRef: {
        post: vi.fn().mockResolvedValue({
          data: AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.byteLength),
          headers: { 'content-type': 'audio/wav', 'x-tts-characters': '5', ...headers },
        }),
      },
    } as never,
    { getConfigValue: vi.fn(() => 'http://tts') } as never,
    {
      run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      set: vi.fn((k: string, v: unknown) => {
        store[k] = v;
      }),
      get: vi.fn((k: string) => store[k]),
    } as never,
    { getSecretSync: vi.fn(() => 'tok') } as never,
    { resolve: vi.fn().mockResolvedValue({ spec: SPEC, providerOverrides: {} }) } as never,
    ledger as never,
    { assertMeterQuota: vi.fn().mockResolvedValue(undefined) } as never,
  );
  await controller.synthesize({ tenantId: 'tenant-a', text: 'Hello', voice: 'v1' } as never);
  await new Promise((resolve) => setImmediate(resolve));
  return { ledger };
}

describe('F-10 · HarnessTtsInternalController', () => {
  it('records the row as before when the service named a provider', async () => {
    const { ledger } = await runHarness({ 'x-tts-provider': 'azure' });
    expect(ledger.recordUsage).toHaveBeenCalled();
    expect(ledger.recordUsage.mock.calls[0][0].common.provider).toBe('azure');
  });

  it('records NOTHING, warns and counts when the header is absent', async () => {
    const before = await emissionFailures();
    const { ledger } = await runHarness({});
    expect(ledger.recordUsage).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(await emissionFailures()).toBe(before + 1);
  });

  it('treats the `none` sentinel exactly like an absent header', async () => {
    const { ledger } = await runHarness({ 'x-tts-provider': UNKNOWN });
    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });
});

// ── 3. the duplex WS bridge ──────────────────────────────────────────────────

type Handler = (...args: unknown[]) => void;
const makeSocket = () => {
  const handlers: Record<string, Handler[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    bufferedAmount: 0,
    on: vi.fn((ev: string, cb: Handler) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit: (ev: string, ...args: unknown[]) => (handlers[ev] || []).forEach((cb) => cb(...args)),
  };
};

async function runWs(provider: string | null) {
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) };
  const upstream = makeSocket();
  const client = makeSocket();
  const gateway = new TtsWsGateway(
    {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn(async () => ({
        userId: 'u1',
        tenantId: 't1',
        scope: 'tts_session:sess-1',
        exp: Date.now() + 30_000,
        impersonatedBy: null,
      })),
    } as never,
    { getConfigValue: vi.fn(() => 'http://tts') } as never,
    { getSecretSync: vi.fn(() => 'svc') } as never,
    undefined as never,
    ledger as never,
  );
  gateway.createUpstreamSocket = vi.fn(() => upstream as never);
  await gateway.handleConnection(client as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t' } as never);
  upstream.emit('open');
  upstream.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, ...(provider === null ? {} : { provider }) })),
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { ledger, client };
}

describe('F-10 · TtsWsGateway', () => {
  it('records the row as before when the frame named a provider', async () => {
    const { ledger } = await runWs('kokoro');
    expect(ledger.recordUsage).toHaveBeenCalled();
    expect(ledger.recordUsage.mock.calls[0][0].common.provider).toBe('kokoro');
  });

  it('records NOTHING, warns and counts when the frame named none', async () => {
    const before = await emissionFailures();
    const { ledger, client } = await runWs(null);
    expect(ledger.recordUsage).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(await emissionFailures()).toBe(before + 1);
    // The frame is still CONSUMED — it is TTS's own control framing and must never
    // reach the client, whether or not it produced a ledger row.
    expect(client.send).not.toHaveBeenCalled();
  });

  it('treats the `none` sentinel exactly like an absent provider', async () => {
    const { ledger } = await runWs(UNKNOWN);
    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });
});
