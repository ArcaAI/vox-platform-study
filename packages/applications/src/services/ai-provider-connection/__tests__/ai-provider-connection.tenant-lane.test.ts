/**
 * AiProviderConnectionService — TENANT BYO lane.
 *
 * `ai-provider-connection.service.test.ts` already locks the write-side privilege boundaries and the
 * "no ciphertext in any read DTO" contract. THIS file locks the additional piece:
 * `resolveTenantCloudOverrides` — the gateway-only decrypt path that turns a
 * tenant's enabled cloud credential into the `provider_overrides` map folded
 * into the SMR generate body.
 *
 * The contracts locked here:
 *   1. Only CLOUD BYO providers are ever injected — a self-host row (however it
 *      got there) is never turned into a credential override.
 *   2. A DISABLED row is skipped, so resolution falls through to SYSTEM/env
 *      (AD-2 order: enabled tenant → SYSTEM → service env).
 *   3. No Vault → `{}` (nothing to decrypt; the write path already rejected).
 *   4. FAIL OPEN PER CREDENTIAL **on decrypt error only**: the bad credential is
 *      skipped, every other credential still resolves, and — unlike the TTS
 *      exemplar's silent `catch { continue; }` — a structured `warn` is logged
 *      carrying ONLY `{tenantId, provider, keyVersion}`. The log-arg shape is
 *      asserted so key material can never creep into it.
 *   5. Tenant isolation: tenant B's resolution is unaffected by tenant A's row.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';

function makeRow(
  overrides: {
    tenantId?: string;
    provider?: string;
    enabled?: boolean;
    baseUrl?: string | null;
    region?: string | null;
    apiVersion?: string | null;
    deploymentName?: string | null;
    encryptedApiKey?: Uint8Array | null;
    keyVersion?: number | null;
    extraJson?: Record<string, unknown> | null;
  } = {},
) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? TENANT_A,
    provider: overrides.provider ?? 'azure',
    baseUrl: overrides.baseUrl ?? null,
    region: overrides.region ?? null,
    apiVersion: overrides.apiVersion ?? null,
    deploymentName: overrides.deploymentName ?? null,
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : overrides.encryptedApiKey,
    keyVersion: overrides.keyVersion === undefined ? 3 : overrides.keyVersion,
    extraJson: overrides.extraJson ?? null,
  });
}

function makeService(opts: { rows?: unknown[]; withVault?: boolean; decrypt?: () => Promise<Buffer> } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn().mockResolvedValue(opts.rows ?? []),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets =
    opts.withVault === false
      ? undefined
      : {
          encrypt: vi.fn(async () => 'vault:v3:cipher'),
          decrypt: vi.fn(opts.decrypt ?? (async () => Buffer.from('plaintext-key', 'utf8'))),
        };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any);
  const warn = vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo, emitter, secrets, warn };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveTenantCloudOverrides — BYO injection resolver', () => {
  it('folds model/project/location from extraJson into the wire entry (vertex/openai BYO)', async () => {
    const { svc } = makeService({
      rows: [
        makeRow({
          provider: 'vertex',
          extraJson: { project: 'my-gcp-project', location: 'us-central1', model: 'gemini-2.0-flash' },
        }),
      ],
    });
    const out = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    // The Python ProviderOverride carries project/location/model; the console
    // stores them in extraJson (no dedicated column), so the gateway emitter
    // MUST forward them or Vertex BYO never reaches the tenant's project.
    expect(out.vertex).toMatchObject({
      api_key: 'plaintext-key',
      project: 'my-gcp-project',
      location: 'us-central1',
      model: 'gemini-2.0-flash',
    });
  });

  it('maps an enabled azure row to the snake_case wire shape', async () => {
    const { svc } = makeService({
      rows: [
        makeRow({
          provider: 'azure',
          baseUrl: 'https://acme.openai.azure.com',
          apiVersion: '2024-10-21',
          deploymentName: 'gpt-4o-mini',
        }),
      ],
    });

    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({
      azure: {
        api_key: 'plaintext-key',
        base_url: 'https://acme.openai.azure.com',
        api_version: '2024-10-21',
        deployment_name: 'gpt-4o-mini',
      },
    });
  });

  it('maps an enabled bedrock row with its region', async () => {
    const { svc } = makeService({
      rows: [makeRow({ provider: 'bedrock', region: 'us-east-1' })],
    });

    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({
      bedrock: { api_key: 'plaintext-key', region: 'us-east-1' },
    });
  });

  it('skips a DISABLED row so resolution falls through to SYSTEM/env', async () => {
    const { svc } = makeService({ rows: [makeRow({ provider: 'azure', enabled: false })] });
    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({});
  });

  it('skips a row with no stored key', async () => {
    const { svc } = makeService({ rows: [makeRow({ encryptedApiKey: null, keyVersion: null })] });
    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({});
  });

  it('never injects a SELF-HOST provider row as a credential override', async () => {
    const { svc } = makeService({
      rows: [makeRow({ provider: 'ollama', baseUrl: 'http://localhost:11434' }), makeRow({ provider: 'vllm' })],
    });
    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({});
  });

  it('returns {} when no Vault secrets provider is wired', async () => {
    const { svc } = makeService({ rows: [makeRow()], withVault: false });
    await expect(svc.resolveTenantCloudOverrides(TENANT_A)).resolves.toEqual({});
  });

  it('is tenant-isolated: tenant B resolves nothing from tenant A rows', async () => {
    const { svc, repo } = makeService({ rows: [] });
    await expect(svc.resolveTenantCloudOverrides(TENANT_B)).resolves.toEqual({});
    // The lookup is pinned to the requested tenant — never widened. Service-first
    // signature: findByTenantIdAndService(service, tenantId, tx) → tenantId is arg 1.
    expect(repo.findByTenantIdAndService.mock.calls[0][1]).toBe(TENANT_B);
    expect(repo.findByTenantIdAndService.mock.calls[0][0]).toBe('llm');
  });

  describe('fail-open per credential ON DECRYPT ERROR ONLY', () => {
    it('skips the broken credential, keeps the healthy one, and logs a NON-SECRET warn', async () => {
      let call = 0;
      const { svc, warn } = makeService({
        rows: [
          makeRow({ provider: 'azure', keyVersion: 7, baseUrl: 'https://acme.openai.azure.com' }),
          makeRow({ provider: 'bedrock', region: 'eu-west-1', keyVersion: 2 }),
        ],
        decrypt: async () => {
          call += 1;
          if (call === 1) throw new Error('vault transit: key version 7 not found');
          return Buffer.from('good-key', 'utf8');
        },
      });

      const out = await svc.resolveTenantCloudOverrides(TENANT_A);

      // The healthy credential still resolves — a broken BYO key degrades to
      // the platform default, it does not take generation down.
      expect(out).toEqual({ bedrock: { api_key: 'good-key', region: 'eu-west-1' } });

      expect(warn).toHaveBeenCalledTimes(1);
      const arg = warn.mock.calls[0][0] as Record<string, unknown>;
      // The 1-arg resolver form resolves the llm lane, so the warn carries service='llm'.
      expect(arg).toMatchObject({ tenantId: TENANT_A, service: 'llm', provider: 'azure', keyVersion: 7 });

      // Nothing beyond the allow-listed fields may be logged, and no serialized
      // value may contain key material or ciphertext.
      expect(Object.keys(arg).sort()).toEqual(['keyVersion', 'message', 'provider', 'service', 'tenantId']);
      const serialized = JSON.stringify(arg);
      expect(serialized).not.toContain('vault:');
      expect(serialized).not.toContain('plaintext-key');
      expect(serialized).not.toContain('good-key');
      expect(serialized).not.toContain('cipher');
    });
  });
});
