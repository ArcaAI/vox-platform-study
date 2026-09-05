/**
 * lane B — the harness BYO provider-credential resolve.
 *
 * `apps/harness` runs its judge and its retriever inside a Temporal ACTIVITY.
 * There is no inbound gateway request to fold a `provider_overrides` envelope
 * into (the `apps/text` channel), and the worker holds no DB handle, so
 * `resolveConnection` is unreachable from that process. The delivery path is
 * therefore the one this repo ALREADY uses for a credential consumed inside an
 * activity — `GET /internal/harness/mcp-token`: the worker asks the gateway
 * INSIDE the activity, uses the value, and discards it. Nothing reaches
 * Temporal history, which is durable storage.
 *
 * This suite pins the resolver's contract, which is the whole security surface:
 *
 *   - tenant → SYSTEM, and SYSTEM ONLY on absence;
 *   - a DISABLED tenant row is a VETO of both tiers (never a fall-through);
 *   - a KEYLESS row injects on neither tier (`absent`, not an empty credential);
 *   - `funding` is DERIVED from the row that supplied the key, never stamped;
 *   - a resolver FAULT is `unavailable` — distinguishable from `absent`, because
 *     the consumer must fail closed on a fault and may proceed unauthenticated
 *     on a genuine "no opinion";
 *   - the credential is never logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const KEY = 'sk-tenant-judge-key';

const providerConnectionService = { resolveTenantCloudOverrides: vi.fn() };

function buildService(withConnections = true) {
  return new HarnessInternalService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    {} as never, // namedEntityRepository
    {} as never, // summaryMetaRepository
    {} as never, // promptAssemblyService
    {} as never, // promptTemplateRepository
    {} as never, // harnessAuditService
    { run: vi.fn(async (cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never, // cls
    undefined as never, // jobService
    undefined as never, // highlightRepository
    undefined as never, // assuranceService
    undefined as never, // configResolver
    undefined as never, // contextItemVersionRepository
    undefined as never, // secretsService
    undefined as never, // redisCache
    undefined as never, // transcriptSegmentRepository
    undefined as never, // harnessPolicyService
    undefined as never, // mcpServerRepository
    undefined as never, // effectiveSettings
    undefined as never, // usageLedgerService
    undefined as never, // notificationService
    withConnections ? (providerConnectionService as never) : undefined,
  );
}


/**
 * the resolve runs INSIDE a CLS tenant context.
 *
 * `resolveTenantCloudOverrides` reads tenant-scoped `AiProviderConnection` rows,
 * and the tenant-scope extension refuses a read with no CLS tenant
 * ("tenant context required"). The harness route is a service-token request
 * with NO user and NO tenant on the CLS store (the same shape as `assemble`,
 * `getEffectivePolicy` and the consent gate), so the service must re-establish
 * the tenant from the query itself — otherwise every self-host credential
 * resolve faults into `unavailable` and the harness fails closed on a row that
 * exists. Measured on hope-v2-dev 2026-09-03: the gateway's own text proxy
 * (inside an HTTP tenant context) resolved the SYSTEM LM Studio row while this
 * route answered `unavailable: credential resolution failed` for the same row.
 */
function buildServiceWithCls(cls: { run: unknown; set: unknown; get: unknown }) {
  return new HarnessInternalService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cls as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    providerConnectionService as never,
  );
}

describe('HarnessInternalService.resolveProviderCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({ overrides: {} });
  });

  it('re-establishes the CLS tenant before touching the tenant-scoped connection rows ', async () => {
    const order: string[] = [];
    const cls = {
      run: vi.fn(async (cb: () => unknown) => {
        order.push('run');
        return cb();
      }),
      set: vi.fn((key: string, value: unknown) => {
        order.push(`set:${key}=${typeof value === 'string' ? value : typeof value}`);
      }),
      get: vi.fn(),
    };
    providerConnectionService.resolveTenantCloudOverrides.mockImplementation(async () => {
      order.push('resolve');
      return { overrides: { 'lm-studio': { api_key: '', base_url: 'http://hope-lmstudio:1234/v1', funding: 'platform' } } };
    });

    const out = await buildServiceWithCls(cls).resolveProviderCredential('llm', 'lm-studio', TENANT);

    expect(out.outcome).toBe('resolved');
    expect(out.baseUrl).toBe('http://hope-lmstudio:1234/v1');
    // Inside `cls.run`, tenant set FIRST, then the read — the same ordering the
    // consent gate and `assemble` pin.
    expect(order.indexOf('run')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`set:tenantId=${TENANT}`)).toBeGreaterThan(order.indexOf('run'));
    expect(order.indexOf('resolve')).toBeGreaterThan(order.indexOf(`set:tenantId=${TENANT}`));
    expect(cls.set).toHaveBeenCalledWith('user', expect.objectContaining({ tenantId: TENANT }));
  });

  it('serves a keyed row and reports the tier that supplied it', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: {
        azure: {
          api_key: KEY,
          funding: 'tenant',
          base_url: 'https://t.example',
          api_version: '2024-12-01-preview',
          deployment_name: 'judge',
        },
      },
    });

    const out = await buildService().resolveProviderCredential('llm', 'azure', TENANT);

    expect(out.outcome).toBe('resolved');
    expect(out.apiKey).toBe(KEY);
    expect(out.funding).toBe('tenant');
    expect(out.baseUrl).toBe('https://t.example');
    expect(out.apiVersion).toBe('2024-12-01-preview');
    expect(out.deploymentName).toBe('judge');
    // The cascade is asked ONCE, for the caller's own tenant — never SYSTEM directly.
    expect(providerConnectionService.resolveTenantCloudOverrides).toHaveBeenCalledWith('llm', TENANT);
  });

  it('reports the SYSTEM tier as platform funding (derived, never stamped)', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: { qdrant: { api_key: KEY, funding: 'platform' } },
    });

    const out = await buildService().resolveProviderCredential('vector', 'qdrant', TENANT);

    expect(out.outcome).toBe('resolved');
    expect(out.funding).toBe('platform');
  });

  it('returns ABSENT — not an empty credential — when no tier has an opinion', async () => {
    const out = await buildService().resolveProviderCredential('llm', 'openai-compat', TENANT);

    expect(out.outcome).toBe('absent');
    expect(out.apiKey).toBeUndefined();
    expect(out.funding).toBeUndefined();
  });

  it('honours a tenant VETO — a disabled row denies BOTH tiers', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: {},
      platformDefault: { entitlementSuppressed: false, vetoed: ['azure'] },
    });

    const out = await buildService().resolveProviderCredential('llm', 'azure', TENANT);

    expect(out.outcome).toBe('denied');
    expect(out.reason).toContain('veto');
  });

  it('denies a CLOUD provider whose platform tier is entitlement-suppressed', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: {},
      platformDefault: { entitlementSuppressed: true, vetoed: [] },
    });

    const out = await buildService().resolveProviderCredential('llm', 'azure', TENANT);

    expect(out.outcome).toBe('denied');
  });

  it('leaves a SELF-HOST provider ABSENT under the same suppression (the gate is about vendor spend)', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockResolvedValue({
      overrides: {},
      platformDefault: { entitlementSuppressed: true, vetoed: [] },
    });

    const out = await buildService().resolveProviderCredential('llm', 'openai-compat', TENANT);

    expect(out.outcome).toBe('absent');
  });

  it('returns UNAVAILABLE (never absent) when the resolver faults', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockRejectedValue(new Error('vault transit down'));

    const out = await buildService().resolveProviderCredential('llm', 'azure', TENANT);

    // The distinction is load-bearing: `absent` lets a consumer proceed
    // unauthenticated, `unavailable` must fail it closed.
    expect(out.outcome).toBe('unavailable');
  });

  it('returns UNAVAILABLE when the connection plane is unwired', async () => {
    const out = await buildService(false).resolveProviderCredential('llm', 'azure', TENANT);

    expect(out.outcome).toBe('unavailable');
  });

  it('rejects an unrecognised service rather than guessing', async () => {
    await expect(buildService().resolveProviderCredential('not-a-service', 'azure', TENANT)).rejects.toThrow();
  });

  it('requires a tenant — a credential resolve has no tenant-less form', async () => {
    await expect(buildService().resolveProviderCredential('llm', 'azure', '')).rejects.toThrow();
  });

  it('never puts key material in a log line', async () => {
    providerConnectionService.resolveTenantCloudOverrides.mockRejectedValue(new Error(`transit choked on ${KEY}`));
    const service = buildService();
    const logged: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = {
      warn: (m: unknown) => logged.push(JSON.stringify(m)),
      error: (m: unknown) => logged.push(JSON.stringify(m)),
      log: (m: unknown) => logged.push(JSON.stringify(m)),
      debug: (m: unknown) => logged.push(JSON.stringify(m)),
    };

    await service.resolveProviderCredential('llm', 'azure', TENANT);

    expect(logged.join('\n')).not.toContain(KEY);
  });
});
