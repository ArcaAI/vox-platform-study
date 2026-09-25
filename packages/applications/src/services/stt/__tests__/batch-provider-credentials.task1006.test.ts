/**
 * TASK-1006 — the batch worker's cloud-ASR credential pull resolves from `AiProviderConnection`,
 * and nothing named `TenantSttConfig` is left to serve it.
 *
 * The Dramatiq message carries `resolved_spec` and never a key, so the worker pulls the tenant's
 * credentials at execution time (`GET internal/stt/provider-overrides?tenantId=`). That pull is
 * `AsrAgentResolverService.resolveProviderOverrides`, built here on the REAL
 * `ProviderCredentialResolver` over a stubbed `AiProviderConnectionService` — so the precedence
 * under test (tenant BYO row wins, SYSTEM row widens on absence, a disabled tenant row vetoes) is
 * the production rule, not a mock of it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCredentialResolver } from '../../ai-provider-connection/provider-credential-resolver';
import { AsrAgentResolverService } from '../agent-resolver/asr-agent-resolver.service';

const TENANT = '51000000-0000-0000-0000-000000000001';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

interface Row {
  id: string;
  tenantId: string;
  provider: string;
  isDefault: boolean;
  enabled: boolean;
  encryptedApiKey: string | null;
}

const row = (overrides: Partial<Row> & Pick<Row, 'id' | 'tenantId' | 'provider'>): Row => ({
  isDefault: true,
  enabled: true,
  encryptedApiKey: `cipher:${overrides.id}`,
  ...overrides,
});

/** Tenant: its own OpenAI key, a DISABLED Azure Speech row (a veto). SYSTEM: Sarvam + Azure Speech + OpenAI. */
const TENANT_ROWS: Row[] = [
  row({ id: 'conn-tenant-openai', tenantId: TENANT, provider: 'openai' }),
  row({ id: 'conn-tenant-azure-speech', tenantId: TENANT, provider: 'azure-speech', enabled: false }),
];
const SYSTEM_ROWS: Row[] = [
  row({ id: 'conn-system-openai', tenantId: SYSTEM, provider: 'openai' }),
  row({ id: 'conn-system-sarvam', tenantId: SYSTEM, provider: 'sarvam' }),
  row({ id: 'conn-system-azure-speech', tenantId: SYSTEM, provider: 'azure-speech' }),
];

function connectionService() {
  return {
    assertResolvable: vi.fn(),
    cascadeRows: vi.fn(async (_service: string, tenantId: string, provider?: string) => {
      const tenantRows = TENANT_ROWS.filter((r) => r.tenantId === tenantId && (!provider || r.provider === provider));
      const vetoed = new Set(tenantRows.filter((r) => r.isDefault && !r.enabled).map((r) => r.provider));
      const systemRows = provider && vetoed.has(provider) ? [] : SYSTEM_ROWS.filter((r) => !provider || r.provider === provider);
      return { tenantRows, systemRows, vetoed, systemEntitled: true };
    }),
    // The decrypt: funding is DERIVED from the row that served, never stamped by the caller.
    toOverrideEntry: vi.fn(async (r: Row) => ({
      api_key: `plain:${r.id}`,
      funding: r.tenantId === SYSTEM ? ('platform' as const) : ('tenant' as const),
      connection_id: r.id,
      connection_slug: r.provider,
    })),
  };
}

function build() {
  const connections = connectionService();
  const credentials = new ProviderCredentialResolver(connections as never);
  const resolver = new AsrAgentResolverService({ resolve: vi.fn() } as never, credentials);
  return { resolver, connections };
}

describe('TASK-1006 — batch ASR credentials come from AiProviderConnection', () => {
  it("the tenant's own BYO row serves its provider, and the SYSTEM row widens only where the tenant has no row", async () => {
    const { resolver } = build();

    const overrides = await resolver.resolveProviderOverrides(TENANT);

    expect(overrides.openai).toMatchObject({ api_key: 'plain:conn-tenant-openai', funding: 'tenant', connection_id: 'conn-tenant-openai' });
    expect(overrides.sarvam).toMatchObject({ api_key: 'plain:conn-system-sarvam', funding: 'platform', connection_id: 'conn-system-sarvam' });
  });

  it('a DISABLED tenant row vetoes its provider — no tier serves it, the SYSTEM key is not a fallback', async () => {
    const { resolver } = build();

    const overrides = await resolver.resolveProviderOverrides(TENANT);

    expect(overrides['azure-speech']).toBeUndefined();
  });

  it('every credential read goes through the AiProviderConnection cascade for the stt service', async () => {
    const { resolver, connections } = build();

    await resolver.resolveProviderOverrides(TENANT);

    const services = new Set(connections.cascadeRows.mock.calls.map(([service]) => service));
    expect([...services]).toEqual(['stt']);
    expect(connections.cascadeRows.mock.calls.every(([, tenantId]) => tenantId === TENANT)).toBe(true);
  });
});

describe('TASK-1006 — TenantSttConfig is gone from the application layer', () => {
  it('the tenant-stt-config service folder no longer exists', () => {
    expect(existsSync(resolve(__dirname, '../../tenant-stt-config'))).toBe(false);
  });

  it('the services barrel exports no TenantSttConfig or AsrPipeline service', async () => {
    const services = (await import('../../index')) as Record<string, unknown>;
    const retired = [
      'TenantSttConfigService',
      'TenantSttConfigServiceModule',
      'ITenantSttConfigService',
      'PipelineService',
      'PipelineServiceModule',
      'IPipelineService',
      'PipelineTemplateResyncService',
      'PipelineTemplateResyncCronService',
      'SttPipelineCompilerService',
      'SttPipelineResolverService',
    ];
    expect(retired.filter((name) => name in services)).toEqual([]);
  });

  it('the credential map type survives the folder — it is the STT wire shape, not a TenantSttConfig concept', async () => {
    const stt = (await import('../index')) as Record<string, unknown>;
    // `SttProviderOverrides` is a type; the runtime marker is that the resolver still builds one.
    expect(typeof stt.AsrAgentResolverService).toBe('function');
    expect(existsSync(resolve(__dirname, '../stt-provider-overrides.ts'))).toBe(true);
  });
});
