/**
 * InferenceReadinessService — TASK-890 §3.12.
 *
 * The sweep answers ONE question per model row: at the last observation, could
 * this model have served? It is deliberately an OBSERVATION and not a promise —
 * every verdict carries the `checkedAt` of the sweep that produced it, and a
 * cold or expired snapshot reports `unknown` rather than guessing.
 *
 * Boundaries mocked: the TEXT probe (HttpService), the connection cascade, the
 * model repository, the heartbeat reader, Redis, settings.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { InferenceReadinessService } from '../inference-readiness.service';
import {
  INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
  INFERENCE_READINESS_ENABLED_KEY,
  INFERENCE_READINESS_INTERVAL_KEY,
  INFERENCE_READINESS_SNAPSHOT_KEY,
} from '../inference-readiness.constants';

/** One `AiModel` row, only the fields the sweep reads. */
function makeModel(over: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'a',
    name: 'Model A',
    provider: 'lm-studio',
    sourceUri: 'a',
    taskType: ModelTaskType.TEXT_GENERATION,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    availability: AiModelAvailability.NOT_APPLICABLE,
    servedBy: 'text',
    ...over,
  };
}

interface HarnessOptions {
  models?: Array<Record<string, unknown>>;
  probe?: unknown;
  probeRejects?: boolean;
  settings?: Record<string, unknown>;
  uptime?: Record<string, { status: string; lastCheck: string }>;
  redisConnected?: boolean;
  connections?: Record<string, { baseUrl?: string | null; encryptedApiKey?: Uint8Array | null } | null>;
}

function makeHarness(options: HarnessOptions = {}) {
  const fresh = new Date().toISOString();
  const settings = options.settings ?? {};

  const appSettings = {
    getValueWithDefault: vi.fn(<T>(key: string, fallback: T): T => (key in settings ? (settings[key] as T) : fallback)),
  };
  const configService = { getConfigValue: vi.fn(() => 'http://text.test:8862') };
  const aiModelRepository = { findAll: vi.fn(async () => (options.models ?? [makeModel()]) as never) };
  const post = vi.fn(async () => {
    if (options.probeRejects) throw new Error('connect ECONNREFUSED');
    return { data: options.probe ?? [] };
  });
  const httpService = { axiosRef: { post } };
  const health = {
    getUptime: vi.fn(async () => ({
      refreshedAt: fresh,
      services: options.uptime ?? { text: { status: 'healthy', lastCheck: fresh } },
    })),
  };
  const store = new Map<string, string>();
  const redis = {
    isConnected: vi.fn(() => options.redisConnected ?? true),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  const providerConnections = {
    resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })),
    resolveConnection: vi.fn(async (_service: string, provider: string) => {
      if (options.connections && provider in options.connections) {
        const row = options.connections[provider];
        return row === null ? null : { baseUrl: row.baseUrl ?? null, encryptedApiKey: row.encryptedApiKey ?? null, source: 'system' };
      }
      return { baseUrl: `http://${provider}.test`, encryptedApiKey: null, source: 'system' };
    }),
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

  return { service, appSettings, configService, aiModelRepository, post, health, redis, store, providerConnections };
}

/** TEXT's `POST /api/v1/providers/probe` reply shape (`ai-model-discovery.service.ts`). */
function probeEntry(name: string, models: Array<{ name: string; state?: string | null }>, status = 'ok') {
  return { name, models, probe_status: status, probe_latency_ms: 12 };
}

beforeEach(() => vi.clearAllMocks());

describe('InferenceReadinessService — engine-served rows', () => {
  it('marks a loaded model ready, a listed-but-cold model loadable, and every row of a failed engine engine_down', async () => {
    const { service } = makeHarness({
      models: [
        makeModel({ id: 'm-a', slug: 'a', sourceUri: 'a', provider: 'lm-studio' }),
        makeModel({ id: 'm-b', slug: 'b', sourceUri: 'b', provider: 'lm-studio' }),
        makeModel({ id: 'm-o', slug: 'o', sourceUri: 'o', provider: 'ollama' }),
      ],
      probe: [
        probeEntry('lm-studio', [
          { name: 'a', state: 'loaded' },
          { name: 'b', state: 'not-loaded' },
        ]),
        {
          name: 'ollama',
          models: [],
          probe_status: 'error',
          probe_error: "Client error '401 Unauthorized' for url 'http://hope-ollama.hope-v2-dev:11434/api/tags'",
        },
      ],
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-a']!.readiness).toBe('ready');
    expect(snapshot.models['m-b']!.readiness).toBe('loadable');
    expect(snapshot.models['m-o']!.readiness).toBe('engine_down');
    // TASK-890 wave-1 close: a MODEL detail is stamped onto the tenant-facing
    // catalogue, so it is a curated phrase — never the upstream's raw
    // `probe_error`, which carries the engine's internal address.
    expect(snapshot.models['m-o']!.detail).toBe('the serving engine did not answer the last probe');
    expect(snapshot.models['m-o']!.detail).not.toContain('http');
    // The super-admin ENGINE document keeps the diagnostic.
    expect(snapshot.engines.find((e) => e.provider === 'ollama')!.detail).toContain('401');
    expect(snapshot.engines.find((e) => e.provider === 'lm-studio')).toMatchObject({ status: 'up', loadedCount: 1, listedCount: 2 });
    expect(snapshot.engines.find((e) => e.provider === 'ollama')).toMatchObject({ status: 'down' });
  });

  it('reports weights_missing for a registered row the engine does not list, but only when the probe succeeded', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-ghost', slug: 'ghost', sourceUri: 'ghost', provider: 'lm-studio' })],
      probe: [probeEntry('lm-studio', [{ name: 'something-else', state: 'loaded' }])],
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-ghost']!.readiness).toBe('weights_missing');
  });

  it('treats a listing with no load state as ready on vLLM and llama.cpp — being listed IS being served there', async () => {
    const { service } = makeHarness({
      models: [
        makeModel({ id: 'm-v', slug: 'v', sourceUri: 'v', provider: 'vllm' }),
        makeModel({ id: 'm-l', slug: 'l', sourceUri: 'l', provider: 'llama-cpp' }),
      ],
      probe: [probeEntry('vllm', [{ name: 'v', state: null }]), probeEntry('llama-cpp', [{ name: 'l' }])],
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-v']!.readiness).toBe('ready');
    expect(snapshot.models['m-l']!.readiness).toBe('ready');
  });

  it('sends ONE probe to the text service — the single aggregator — at the configured URL', async () => {
    const { service, post, configService } = makeHarness({ probe: [] });
    await service.sweep();

    expect(configService.getConfigValue).toHaveBeenCalledWith('TEXT_URL');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe('http://text.test:8862/api/v1/providers/probe');
  });

  it('degrades every engine to unknown — never down — when the text service itself is unreachable', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-a', provider: 'lm-studio' })],
      probeRejects: true,
    });

    const snapshot = await service.sweep();
    expect(snapshot.engines.every((engine) => engine.status === 'unknown')).toBe(true);
    expect(snapshot.models['m-a']!.readiness).toBe('unknown');
  });
});

describe('InferenceReadinessService — platform-served rows', () => {
  const fresh = () => new Date().toISOString();
  const stale = () => new Date(Date.now() - 10 * 60_000).toISOString();

  it('is ready when the weights are AVAILABLE and the serving service heartbeat is fresh', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-stt', provider: 'built-in', servedBy: 'stt', availability: AiModelAvailability.AVAILABLE })],
      uptime: { stt: { status: 'healthy', lastCheck: fresh() } },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-stt']!.readiness).toBe('ready');
  });

  it('is engine_down when the weights are AVAILABLE but the serving service heartbeat is stale', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-stt', provider: 'built-in', servedBy: 'stt', availability: AiModelAvailability.AVAILABLE })],
      uptime: { stt: { status: 'healthy', lastCheck: stale() } },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-stt']!.readiness).toBe('engine_down');
  });

  it('is weights_missing when the bucket inventory measured MISSING or PARTIAL, whatever the heartbeat says', async () => {
    const { service } = makeHarness({
      models: [
        makeModel({ id: 'm-miss', provider: 'built-in', servedBy: 'stt', availability: AiModelAvailability.MISSING }),
        makeModel({ id: 'm-part', provider: 'built-in', servedBy: 'stt', availability: AiModelAvailability.PARTIAL }),
      ],
      uptime: { stt: { status: 'healthy', lastCheck: fresh() } },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-miss']!.readiness).toBe('weights_missing');
    expect(snapshot.models['m-part']!.readiness).toBe('weights_missing');
  });

  it('is unknown while availability has never been measured — the inventory sweep has not run', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-u', provider: 'built-in', servedBy: 'stt', availability: AiModelAvailability.UNKNOWN })],
      uptime: { stt: { status: 'healthy', lastCheck: fresh() } },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-u']!.readiness).toBe('unknown');
  });
});

describe('InferenceReadinessService — cloud platform rows', () => {
  it('is ready when the SYSTEM connection resolves WITH a key, credential_missing when it resolves keyless', async () => {
    const { service } = makeHarness({
      models: [
        makeModel({ id: 'm-az', provider: 'azure', deploymentKind: AiDeploymentKind.CLOUD, servedBy: 'text' }),
        makeModel({ id: 'm-oa', provider: 'openai', deploymentKind: AiDeploymentKind.CLOUD, servedBy: 'text' }),
      ],
      connections: {
        azure: { baseUrl: 'https://azure.test', encryptedApiKey: new Uint8Array([1]) },
        openai: { baseUrl: 'https://openai.test', encryptedApiKey: null },
      },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-az']!.readiness).toBe('ready');
    expect(snapshot.models['m-oa']!.readiness).toBe('credential_missing');
  });

  it('is credential_missing when no tier answers at all (no row, or a tenant veto)', async () => {
    const { service } = makeHarness({
      models: [makeModel({ id: 'm-an', provider: 'anthropic', deploymentKind: AiDeploymentKind.CLOUD, servedBy: 'text' })],
      connections: { anthropic: null },
    });

    const snapshot = await service.sweep();
    expect(snapshot.models['m-an']!.readiness).toBe('credential_missing');
  });

  it('re-resolves a cloud connection at most once per cloudProbeIntervalSeconds — a resolve is a Vault decrypt', async () => {
    const { service, providerConnections } = makeHarness({
      models: [makeModel({ id: 'm-az', provider: 'azure', deploymentKind: AiDeploymentKind.CLOUD, servedBy: 'text' })],
      connections: { azure: { baseUrl: 'https://azure.test', encryptedApiKey: new Uint8Array([1]) } },
      settings: { [INFERENCE_READINESS_INTERVAL_KEY]: 0, [INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY]: 900 },
    });

    await service.sweep();
    await service.sweep();

    const azureResolves = providerConnections.resolveConnection.mock.calls.filter((call) => call[1] === 'azure');
    expect(azureResolves).toHaveLength(1);
    // The cached verdict still reaches the second snapshot.
    const snapshot = await service.getSnapshot();
    expect(snapshot!.models['m-az']!.readiness).toBe('ready');
  });
});

describe('InferenceReadinessService — the snapshot', () => {
  it('stamps checkedAt and stores one Redis entry with a TTL of three intervals', async () => {
    const { service, redis } = makeHarness({ settings: { [INFERENCE_READINESS_INTERVAL_KEY]: 30 } });

    const before = Date.now();
    const snapshot = await service.sweep();

    expect(new Date(snapshot.checkedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.setex.mock.calls[0]![0]).toBe(INFERENCE_READINESS_SNAPSHOT_KEY);
    expect(redis.setex.mock.calls[0]![1]).toBe(90);
  });

  it('reads the stored snapshot back through Redis', async () => {
    const { service } = makeHarness();
    const written = await service.sweep();
    const read = await service.getSnapshot();

    expect(read).not.toBeNull();
    expect(read!.checkedAt).toBe(written.checkedAt);
  });

  it('skips the store when Redis is unavailable, and still serves the in-process observation', async () => {
    const { service, redis } = makeHarness({ redisConnected: false });

    const written = await service.sweep();
    expect(redis.setex).not.toHaveBeenCalled();
    // The sweep is still a real observation — the heartbeat precedent skips the
    // WRITE on an absent Redis, it does not skip the work.
    expect(await service.getSnapshot()).toMatchObject({ checkedAt: written.checkedAt });
  });

  it('returns null before the first sweep', async () => {
    const { service } = makeHarness();
    expect(await service.getSnapshot()).toBeNull();
  });
});

describe('InferenceReadinessService — the schedule', () => {
  it('does nothing when the platform switch is off', async () => {
    const { service, post, aiModelRepository } = makeHarness({ settings: { [INFERENCE_READINESS_ENABLED_KEY]: false } });

    await service.scheduledSweep();

    expect(post).not.toHaveBeenCalled();
    expect(aiModelRepository.findAll).not.toHaveBeenCalled();
  });

  it('skips a tick that arrives sooner than the configured interval', async () => {
    const { service, post } = makeHarness({ settings: { [INFERENCE_READINESS_INTERVAL_KEY]: 3600 } });

    await service.scheduledSweep();
    await service.scheduledSweep();

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('an explicit refresh ignores the interval — a platform admin asked for it now', async () => {
    const { service, post } = makeHarness({ settings: { [INFERENCE_READINESS_INTERVAL_KEY]: 3600 } });

    await service.sweep();
    await service.sweep();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never lets a sweep failure escape the scheduler', async () => {
    const { service, aiModelRepository } = makeHarness();
    aiModelRepository.findAll.mockRejectedValueOnce(new Error('database down'));

    await expect(service.scheduledSweep()).resolves.toBeUndefined();
  });
});

describe('InferenceReadinessService — tenancy', () => {
  it('resolves engine connections EXPLICITLY against the SYSTEM tenant — a cron has no tenant of its own', async () => {
    const { service, providerConnections } = makeHarness({ probe: [] });
    await service.sweep();

    expect(providerConnections.resolveTenantCloudOverrides).toHaveBeenCalledWith('llm', SYSTEM_TENANT_ID);
    for (const call of providerConnections.resolveConnection.mock.calls) {
      expect(call[2]).toBe(SYSTEM_TENANT_ID);
    }
  });

  it('reads only SYSTEM catalogue rows — a tenant BYO row is not the platform’s to observe', async () => {
    const { service, aiModelRepository } = makeHarness();
    await service.sweep();

    const filters = aiModelRepository.findAll.mock.calls[0]![0].filters as Record<string, unknown>;
    expect(filters.tenantId).toBe(SYSTEM_TENANT_ID);
  });
});
