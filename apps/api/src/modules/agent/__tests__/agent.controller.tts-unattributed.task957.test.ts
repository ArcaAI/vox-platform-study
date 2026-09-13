/**
 * TASK-957 F-10, agent-plane half — `POST /agents/:slug/speech`.
 *
 * The fourth of the four gateway readers of `X-Tts-Provider`. Same rule as the three in
 * `../../speech/__tests__/tts-unattributed-provider.task957.test.ts`, and it is stated once
 * there: an absent header, or `apps/tts`'s own `"none"` sentinel, is the service declining to
 * name what served. A row written anyway claims `provider: 'none'` (in no price book, so zero
 * COGS) on `deployment: SELF_HOSTED` (the platform's own hardware — the one claim the evidence
 * contradicts), while still draining the tenant's CHARACTER allowance. So: no row, a warn
 * carrying the request id, and the emission-failure counter.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { Logger } from '@nestjs/common';
import { USAGE_EMISSION_FAILED_METRIC } from '@arcaai/applications';
import { register } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';

const TTS_AGENT = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'clinic-voice',
  versionNumber: 1,
  task: 'TEXT_TO_SPEECH',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: {
    task: 'TEXT_TO_SPEECH',
    service: 'tts',
    model: { id: 'm', slug: 'kokoro-82m', provider: 'kokoro', taskType: 'TEXT_TO_SPEECH' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
    protocols: ['http'],
  },
  models: [],
  guardrail: { enabled: true },
};

const fakeRes = () => {
  const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), status: vi.fn(() => res), json: vi.fn(), on: vi.fn() };
  return res;
};

async function emissionFailures(): Promise<number> {
  const metric = register.getSingleMetric(USAGE_EMISSION_FAILED_METRIC);
  if (!metric) return 0;
  const { values } = (await metric.get()) as { values: { labels: Record<string, string>; value: number }[] };
  return values.filter((v) => v.labels.operation === 'tts.synthesize').reduce((sum, v) => sum + v.value, 0);
}

async function run(headers: Record<string, string>) {
  const upstream = new PassThrough();
  // Untyped `vi.fn()` on purpose (as the speech-module twin does): a zero-arg
  // implementation types `mock.calls[0]` as `[]` and the provider assertion below
  // fails `tsc --noEmit` even though vitest runs it fine.
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ written: 1 }) };
  const controller = new AgentController(
    { listPublished: vi.fn(), getPublishedBySlug: vi.fn() } as never,
    { resolve: vi.fn(async () => TTS_AGENT) } as never,
    { buildSpeechRequest: vi.fn(() => ({ input: 'hello there', voice: 'v1', model: 'kokoro-82m' })) } as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    { axiosRef: { post: vi.fn(async () => ({ data: upstream, headers: { 'content-type': 'audio/wav', ...headers } })) } } as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    { assertMeterQuota: vi.fn(async () => undefined) } as never,
    usageLedger as never,
    { createBatchJob: vi.fn(), failJob: vi.fn() } as never,
    { dispatchDramatiqJob: vi.fn() } as never,
    { fetchById: vi.fn() } as never,
    { resolve: vi.fn() } as never,
    { assertSpendLimit: vi.fn(async () => undefined) } as never,
    { resolve: vi.fn(async () => 'cpu') } as never,
  );

  await controller.speech('clinic-voice', { text: 'hello there' } as never, fakeRes() as never);
  upstream.end();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { usageLedger };
}

describe('TASK-957 F-10 — agent speech skips a row it cannot attribute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('records the row as before when the service named a provider', async () => {
    const { usageLedger } = await run({ 'x-tts-provider': 'kokoro', 'x-tts-device': 'cuda', 'x-tts-synthesis-ms': '900' });
    expect(usageLedger.recordUsage).toHaveBeenCalled();
    expect(usageLedger.recordUsage.mock.calls[0][0].common.provider).toBe('kokoro');
  });

  it('records NOTHING, warns and counts when the header is absent', async () => {
    const before = await emissionFailures();
    const { usageLedger } = await run({ 'x-tts-synthesis-ms': '900' });
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(await emissionFailures()).toBe(before + 1);
  });

  it('treats the `none` sentinel exactly like an absent header', async () => {
    const { usageLedger } = await run({ 'x-tts-provider': 'none', 'x-tts-synthesis-ms': '900' });
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});
