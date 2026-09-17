/**
 * TASK-959 §3.2 — the agent speech route records what the TTS service spent.
 *
 * `gen_s` — a `perf_counter` around the whole synthesis — has existed in `apps/tts` all along,
 * fed a Prometheus RTF histogram and was then discarded. Since the P-TTS lane the response
 * carries `X-Tts-Synthesis-Ms`, `X-Tts-Device`, `X-Tts-Response-Bytes` and `X-Tts-Byte-Source`,
 * so the `tts.synthesize` row can carry occupancy and bytes beside the characters it always had.
 *
 * Two asymmetries this pins, both from the P-TTS lane's own report:
 *
 *  · a STREAMED synthesis cannot know its total at header time, so `X-Tts-Synthesis-Ms` is
 *    batch-only and the GATEWAY times the relay instead. That is the honest substitute — the
 *    seconds the tenant held the engine — and it is the same rule the TTS lane applied to itself;
 *  · `X-Tts-Device` is ABSENT for a cloud engine that runs on nobody's hardware of ours (Azure,
 *    Sarvam). Absent means NO compute row. Guessing `cpu` there would invent a platform cost for
 *    a call the platform did not compute.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';
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
  },
  models: [],
  guardrail: { enabled: true },
};

function fakeRes() {
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
    on: vi.fn(),
  };
  return res;
}

function make(headers: Record<string, string>) {
  const upstream = new PassThrough();
  const resolver = { resolve: vi.fn(async () => TTS_AGENT) };
  const invocation = {
    buildSpeechRequest: vi.fn(() => ({ input: 'hello there', voice: 'v1', model: 'kokoro-82m' })),
  };
  const usageLedger = { recordUsage: vi.fn(async () => ({ written: 1 })) };
  const httpService = {
    axiosRef: { post: vi.fn(async () => ({ data: upstream, headers: { 'content-type': 'audio/wav', ...headers } })) },
  };
  const controller = new AgentController(
    { listPublished: vi.fn(), getPublishedBySlug: vi.fn() } as never,
    resolver as never,
    invocation as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    httpService as never,
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
    // TASK-959 — the compute-device resolver. Never consulted on this route: `apps/tts` reports
    // the device it used on the response headers, so nothing here asks configuration for one.
    { resolve: vi.fn(async () => 'cpu') } as never,
  );
  return { controller, usageLedger, upstream };
}

type Batch = { common: Record<string, unknown>; units: { unit: string; quantity: number | string; attributesJson?: Record<string, unknown> }[] };
const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }): Batch[] => ledger.recordUsage.mock.calls.map((call) => call[0] as Batch);
const unitOf = (batch: Batch | undefined, unit: AiUsageUnit) => batch?.units.find((line) => line.unit === unit);

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('TASK-959 §3.2 — tts.synthesize compute and bytes', () => {
  it('records the synthesis seconds the service reported, in the unit its device decides', async () => {
    const { controller, usageLedger, upstream } = make({
      'x-tts-provider': 'kokoro',
      'x-tts-synthesis-ms': '1500',
      'x-tts-device': 'cuda',
      'x-tts-response-bytes': '65536',
      'x-tts-byte-source': 'wire',
    });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.write(Buffer.alloc(1024));
    upstream.end();
    await settle();

    const [batch] = recorded(usageLedger);
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: '1.500', attributesJson: { device: 'cuda' } });
    expect(unitOf(batch, AiUsageUnit.CHARACTER)).toMatchObject({ quantity: 11 });
  });

  it('records the audio bytes the service produced, with the source it declared', async () => {
    const { controller, usageLedger, upstream } = make({
      'x-tts-provider': 'azure',
      'x-tts-device': 'cpu',
      'x-tts-synthesis-ms': '900',
      'x-tts-response-bytes': '65536',
      'x-tts-byte-source': 'app',
    });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const [batch] = recorded(usageLedger);
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: '65536', attributesJson: { byteSource: 'app' } });
  });

  it('meters a cloud synthesis on the PLATFORM’s CPU — never on a vendor’s hardware, device header or not', async () => {
    // `azure` classifies as CLOUD, and a vendor call is the owner's M-3: what HOPE spent is the
    // CPU of the service that made the call. So an absent `X-Tts-Device` suppresses nothing here
    // — it cannot promote the row to a GPU second, which is the only outcome that would be a
    // fabricated cost. (Absent device suppresses the row on a SELF_HOSTED call, where the device
    // is the whole question: see the shared helper's rule 1.)
    const { controller, usageLedger, upstream } = make({
      'x-tts-provider': 'azure',
      'x-tts-synthesis-ms': '900',
      'x-tts-response-bytes': '2048',
    });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const batches = recorded(usageLedger);
    // One batch: a CLOUD call is already INTERNAL, so the CPU row needs no second basis.
    expect(batches).toHaveLength(1);
    expect(unitOf(batches[0], AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(unitOf(batches[0], AiUsageUnit.CPU_SECOND)).toMatchObject({ quantity: '0.900', attributesJson: { device: 'cpu' } });
    // The bytes are still real and still recorded.
    expect(unitOf(batches[0], AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: '2048' });
  });

  it('records NO compute row for a SELF_HOSTED synthesis whose device the service did not name', async () => {
    // `kokoro` is one of ours, so the device is the whole question and a guess would be a GPU
    // second billed at a CPU call's price or the reverse.
    const { controller, usageLedger, upstream } = make({ 'x-tts-provider': 'kokoro', 'x-tts-synthesis-ms': '900', 'x-tts-response-bytes': '2048' });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const [batch] = recorded(usageLedger);
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.CHARACTER)).toBeDefined();
  });

  it('times the relay itself when the service could not report a total — the streamed modes', async () => {
    const { controller, usageLedger, upstream } = make({ 'x-tts-provider': 'kokoro', 'x-tts-device': 'cuda' });
    // A streamed synthesis knows no total at header time, so the gateway's own wall clock is the
    // occupancy figure. Deterministic here rather than timing-dependent.
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(1_000_000).mockReturnValue(1_002_500);

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.write(Buffer.alloc(4096));
    upstream.end();
    await settle();

    const [batch] = recorded(usageLedger);
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: '2.500', attributesJson: { device: 'cuda' } });
  });

  it('counts the bytes it relayed when the service reported none, and says they are an app-level count', async () => {
    const { controller, usageLedger, upstream } = make({ 'x-tts-provider': 'kokoro', 'x-tts-device': 'cpu' });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.write(Buffer.alloc(1024));
    upstream.write(Buffer.alloc(512));
    upstream.end();
    await settle();

    const [batch] = recorded(usageLedger);
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: '1536', attributesJson: { byteSource: 'app' } });
  });

  it('records the compute of an INTERRUPTED synthesis too — those seconds were occupied', async () => {
    const { controller, usageLedger, upstream } = make({
      'x-tts-provider': 'kokoro',
      'x-tts-device': 'cuda',
      'x-tts-synthesis-ms': '800',
      'x-tts-response-bytes': '4096',
    });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.emit('error', new Error('socket died'));
    await settle();

    const [batch] = recorded(usageLedger);
    expect(batch?.common.attributesJson).toMatchObject({ interrupted: true });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: '0.800' });
  });
});
