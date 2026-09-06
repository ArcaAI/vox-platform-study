/**
 * TASK-890 §3.12 + §3.7 — a cloud row's readiness once the probe reports.
 *
 * The sweep's cloud verdict was "the cascade resolved a keyed connection", and
 * it said so honestly ("not vendor-probed"): asking a vendor is a metered call,
 * and there was nothing to ask WITH. Now that
 * `POST /admin/providers/:service/:provider/test` returns `discoveredModels`
 * (§3.7), the sweep can consume the REAL outcome for the SYSTEM tier — bounded
 * by the same `cloudProbeIntervalSeconds` memo that already bounds the Vault
 * decrypt, so a fleet of cloud rows still costs at most one vendor call per
 * provider per interval.
 *
 * The verdicts pinned here:
 *   - probe ok            → `ready`, and the detail says how many models the
 *                           vendor listed when it listed any;
 *   - probe rejected (auth)→ `credential_missing` — the key is present and the
 *                           vendor refused it, which is exactly the actionable
 *                           case the old "ready" hid;
 *   - probe unreachable    → `unknown`, never `ready` and never `engine_down`
 *                           (a cloud row has no engine of ours to be down);
 *   - probe absent/throws  → today's behaviour, unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { InferenceReadinessService } from '../inference-readiness.service';
import { INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY, INFERENCE_READINESS_INTERVAL_KEY } from '../inference-readiness.constants';

function cloudRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-az',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'azure-gpt',
    name: 'Azure GPT',
    provider: 'azure',
    sourceUri: 'gpt-4o-mini',
    taskType: ModelTaskType.TEXT_GENERATION,
    deploymentKind: AiDeploymentKind.CLOUD,
    availability: AiModelAvailability.NOT_APPLICABLE,
    servedBy: 'text',
    ...over,
  };
}

function makeHarness(options: { probeResult?: unknown; probeThrows?: boolean; settings?: Record<string, unknown> } = {}) {
  const settings = options.settings ?? {};
  const appSettings = { getValueWithDefault: vi.fn(<T>(key: string, fallback: T): T => (key in settings ? (settings[key] as T) : fallback)) };
  const configService = { getConfigValue: vi.fn(() => 'http://text.test:8862') };
  const aiModelRepository = { findAll: vi.fn(async () => [cloudRow()] as never) };
  const httpService = { axiosRef: { post: vi.fn(async () => ({ data: [] })) } };
  const fresh = new Date().toISOString();
  const health = { getUptime: vi.fn(async () => ({ refreshedAt: fresh, services: { text: { status: 'healthy', lastCheck: fresh } } })) };
  const store = new Map<string, string>();
  const redis = {
    isConnected: vi.fn(() => true),
    setex: vi.fn(async (k: string, _t: number, v: string) => void store.set(k, v)),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
  };
  const providerConnections = {
    resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })),
    resolveConnection: vi.fn(async () => ({ baseUrl: 'https://azure.test', encryptedApiKey: new Uint8Array([1]), source: 'system' })),
  };
  const probe = {
    test: vi.fn(async () => {
      if (options.probeThrows) throw new Error('boom');
      return options.probeResult as never;
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
    options.probeResult === undefined && !options.probeThrows ? undefined : (probe as never),
  );
  return { service, probe, providerConnections };
}

beforeEach(() => vi.clearAllMocks());

describe('cloudReadiness — consuming the real probe outcome', () => {
  it('is ready when the vendor answered, and counts what it listed', async () => {
    const { service, probe } = makeHarness({
      probeResult: { ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'platform', discoveredModels: ['gpt-4o-mini', 'gpt-4.1'] },
    });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-az']!.readiness).toBe('ready');
    expect(snapshot.models['m-az']!.detail).toContain('2');
    // The SYSTEM tier, always — a per-tenant probe would spend a tenant's quota
    // on a platform sweep.
    expect(probe.test).toHaveBeenCalledWith('llm', 'azure', SYSTEM_TENANT_ID, {});
  });

  it('is credential_missing when the vendor REJECTED a key that is present', async () => {
    const { service } = makeHarness({ probeResult: { ok: false, message: 'Rejected — invalid key', probe: 'auth', source: 'platform' } });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-az']!.readiness).toBe('credential_missing');
    expect(snapshot.models['m-az']!.detail).toContain('Rejected');
  });

  it('is unknown — never ready — when the endpoint could not be reached', async () => {
    const { service } = makeHarness({ probeResult: { ok: false, message: 'Could not reach provider: timeout', probe: 'reachability', source: 'platform' } });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-az']!.readiness).toBe('unknown');
  });

  it('falls back to the credential-only verdict when the probe itself fails', async () => {
    const { service } = makeHarness({ probeThrows: true });

    const snapshot = await service.sweep();

    expect(snapshot.models['m-az']!.readiness).toBe('ready');
    expect(snapshot.models['m-az']!.detail).toContain('not vendor-probed');
  });

  it('probes at most once per cloudProbeIntervalSeconds, like the cascade resolve it rides with', async () => {
    const { service, probe } = makeHarness({
      probeResult: { ok: true, message: 'ok', probe: 'auth', source: 'platform' },
      settings: { [INFERENCE_READINESS_INTERVAL_KEY]: 0, [INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY]: 900 },
    });

    await service.sweep();
    await service.sweep();

    expect(probe.test).toHaveBeenCalledTimes(1);
  });
});
