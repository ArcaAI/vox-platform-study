/**
 * TASK-890 J1 MAJOR-A — a self-hosted row's readiness follows the RUNTIME path.
 *
 * `selfHostReadiness` derived its verdict from `AiModel.availability`, which
 * `ModelInventoryService` measures against the `hope-models` MinIO bucket and
 * stamps `MISSING` on every row whose `bucketPrefix` is NULL. But the serving
 * services never read that bucket for these rows: `apps/stt` resolves
 * `source_uri` into the HuggingFace cache and `apps/nlp` does the same through
 * `HF_HOME`. Measured on the dev catalogue, 21 of 33 rows — every whisper row,
 * `medical-ner`, `gliner2`, `kokoro` — were reported unusable with the weights
 * on the serving host's disk.
 *
 * The sweep now ASKS the service that would serve the row
 * (`GET|POST /api/v1/internal/models/resolvable`, read-only, network-free) and
 * folds the answer in. What must hold:
 *
 *   • resolvable          -> `ready`, whatever the bucket says;
 *   • not resolvable      -> `weights_missing` (unless the bucket has it, which
 *                            is still a real way to obtain the weights);
 *   • service unreachable -> `unknown`, never a verdict. Nobody looked.
 *
 * And one non-negotiable: the sweep must not ask a service it has no address
 * for, must not ask about a cloud or engine-served row, and one service's
 * failure must not affect another's rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { InferenceReadinessService } from '../inference-readiness.service';

function makeModel(over: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'a',
    name: 'Model A',
    provider: 'built-in',
    sourceUri: 'org/repo',
    libraryName: 'transformers',
    taskType: ModelTaskType.SPEECH_TO_TEXT,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    availability: AiModelAvailability.MISSING,
    servedBy: 'stt',
    ...over,
  };
}

interface Options {
  models?: Array<Record<string, unknown>>;
  /** `servedBy` -> the resolvable verdicts that service returns, keyed by model id. */
  resolvable?: Record<string, Record<string, boolean> | 'unreachable'>;
  uptime?: Record<string, { status: string; lastCheck: string }>;
  urls?: Record<string, string | undefined>;
}

const fresh = () => new Date().toISOString();

function makeHarness(options: Options = {}) {
  const appSettings = { getValueWithDefault: vi.fn(<T>(_k: string, fallback: T): T => fallback) };
  const urls: Record<string, string> = {
    TEXT_URL: 'http://text.test:8862',
    STT_URL: 'http://stt.test:8861',
    NLP_URL: 'http://nlp.test:8864',
    TTS_URL: 'http://tts.test:8865',
    ...(options.urls ?? {}),
  };
  const configService = {
    getConfigValue: vi.fn((key: string) => {
      if (options.urls && key in options.urls) return options.urls[key];
      return urls[key];
    }),
  };
  const aiModelRepository = { findAll: vi.fn(async () => (options.models ?? [makeModel()]) as never) };

  const resolvableCalls: Array<{ url: string; body: unknown }> = [];
  const post = vi.fn(async (url: string, body: unknown) => {
    if (url.includes('/providers/probe')) return { data: [] };
    resolvableCalls.push({ url, body });
    const service = Object.keys(options.resolvable ?? {}).find((key) => url.includes(`${key}.test`));
    const answers = service ? options.resolvable![service] : undefined;
    if (answers === 'unreachable') throw new Error('connect ECONNREFUSED');
    const rows = (body as { models: Array<{ id: string }> }).models;
    return {
      data: {
        service,
        results: rows.map((row) => ({
          id: row.id,
          resolvable: answers?.[row.id] ?? false,
          state: answers?.[row.id] ? 'hf_cache' : 'not_cached',
          detail: 'stub',
          path: null,
        })),
      },
    };
  });
  const httpService = { axiosRef: { post } };
  const health = {
    getUptime: vi.fn(async () => ({
      refreshedAt: fresh(),
      services: options.uptime ?? {
        stt: { status: 'healthy', lastCheck: fresh() },
        nlp: { status: 'healthy', lastCheck: fresh() },
        tts: { status: 'healthy', lastCheck: fresh() },
      },
    })),
  };
  const redis = { isConnected: vi.fn(() => false), setex: vi.fn(), get: vi.fn(async () => null) };
  const providerConnections = {
    resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })),
    resolveConnection: vi.fn(async () => null),
  };

  const service = new InferenceReadinessService(
    configService as never,
    appSettings as never,
    providerConnections as never,
    aiModelRepository as never,
    httpService as never,
    health as never,
    redis as never,
    undefined,
  );

  return { service, post, resolvableCalls, configService };
}

beforeEach(() => vi.clearAllMocks());

describe('InferenceReadinessService — runtime resolvability (J1 MAJOR-A)', () => {
  it('is ready when the serving service resolves the weights, even though the bucket says MISSING', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-whisper', availability: AiModelAvailability.MISSING })],
      resolvable: { stt: { 'm-whisper': true } },
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-whisper']!.readiness).toBe('ready');
  });

  it('stays weights_missing when neither the bucket nor the runtime has them', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-cold', availability: AiModelAvailability.MISSING })],
      resolvable: { stt: { 'm-cold': false } },
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-cold']!.readiness).toBe('weights_missing');
    expect(snapshot.models['m-cold']!.detail).toMatch(/stt/);
  });

  it('keeps a bucket-AVAILABLE row ready even when the runtime has not fetched it yet', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-bucket', availability: AiModelAvailability.AVAILABLE })],
      resolvable: { stt: { 'm-bucket': false } },
    });

    const snapshot = await service.sweep();

    // The bucket is still a real way to obtain the weights — the first load
    // pays a fetch. Reporting `weights_missing` here would be a regression,
    // not an improvement.
    expect(snapshot.models['m-bucket']!.readiness).toBe('ready');
  });

  it('reports unknown when the serving service cannot be reached — nobody looked', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-x', availability: AiModelAvailability.UNKNOWN })],
      resolvable: { stt: 'unreachable' },
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-x']!.readiness).toBe('unknown');
  });

  it('asks each serving service ONCE, in a batch, with only its own rows', async () => {
    const { service, resolvableCalls } = makeHarness({
      models: [
        makeModel({ id: 's1', servedBy: 'stt' }),
        makeModel({ id: 's2', servedBy: 'stt' }),
        makeModel({ id: 'n1', servedBy: 'nlp', taskType: ModelTaskType.TOKEN_CLASSIFICATION }),
      ],
      resolvable: { stt: { s1: true, s2: false }, nlp: { n1: true } },
    });

    await service.sweep();

    expect(resolvableCalls).toHaveLength(2);
    const stt = resolvableCalls.find((c) => c.url.includes('stt.test'))!;
    const nlp = resolvableCalls.find((c) => c.url.includes('nlp.test'))!;
    expect(stt.url).toBe('http://stt.test:8861/api/v1/internal/models/resolvable');
    expect((stt.body as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual(['s1', 's2']);
    expect((nlp.body as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual(['n1']);
  });

  it('sends the row fields the service needs to answer, in the wire shape it declares', async () => {
    const { resolvableCalls, service } = makeHarness({
      models: [makeModel({ id: 's1', sourceUri: 'org/repo', libraryName: 'faster-whisper', sourceRevision: 'abc123' })],
      resolvable: { stt: { s1: true } },
    });

    await service.sweep();

    expect((resolvableCalls[0]!.body as { models: unknown[] }).models[0]).toEqual({
      id: 's1',
      sourceUri: 'org/repo',
      library: 'faster-whisper',
      revision: 'abc123',
    });
  });

  it('never asks about a cloud or engine-served row', async () => {
    const { service, resolvableCalls } = makeHarness({
      models: [
        makeModel({ id: 'engine', provider: 'lm-studio', servedBy: 'text', taskType: ModelTaskType.TEXT_GENERATION }),
        makeModel({
          id: 'cloud',
          provider: 'azure',
          deploymentKind: AiDeploymentKind.CLOUD,
          servedBy: 'text',
          taskType: ModelTaskType.TEXT_GENERATION,
        }),
      ],
      resolvable: {},
    });

    await service.sweep();

    expect(resolvableCalls).toHaveLength(0);
  });

  it('does not let one service’s failure change another service’s rows', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 's1', servedBy: 'stt' }), makeModel({ id: 'n1', servedBy: 'nlp', taskType: ModelTaskType.TOKEN_CLASSIFICATION })],
      resolvable: { stt: 'unreachable', nlp: { n1: true } },
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['s1']!.readiness).toBe('unknown');
    expect(snapshot.models['n1']!.readiness).toBe('ready');
  });

  it('does not ask a service it has no address for', async () => {
    const { service, resolvableCalls } = makeHarness({
      models: [makeModel({ id: 't1', servedBy: 'tts', taskType: ModelTaskType.TEXT_TO_SPEECH })],
      urls: { TTS_URL: undefined },
      resolvable: { tts: { t1: true } },
    });

    const snapshot = await service.sweep();

    expect(resolvableCalls).toHaveLength(0);
    expect(snapshot.models['t1']!.readiness).toBe('unknown');
  });
});
