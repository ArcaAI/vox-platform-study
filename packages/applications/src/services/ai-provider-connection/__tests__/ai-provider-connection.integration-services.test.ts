/**
 * C — a tenant secret that is NOT a vendor LLM/STT/TTS credential.
 *
 * Two defects are locked here:
 *
 *   C.1 — `service` was a closed `{llm,stt,tts}` set, so a Qdrant key, a TEI
 *         reranker endpoint or an embeddings credential had NOWHERE to live.
 *         The connection plane is now the home for those integrations too, and
 *         every guarantee the LLM lane already had must hold for them verbatim:
 *         Vault-Transit at rest, tenant → SYSTEM in exactly two tiers, the
 *         three `enabled` states, and DERIVED funding.
 *
 *   C.2 — `toOverrideEntry` forwarded a FIXED allow-list of four extras, so
 *         `extraJson` accepted anything and silently dropped almost all of it.
 *         Per-endpoint capability quirks could not be expressed even though the
 *         column existed. Forwarding is now a VALIDATED PASSTHROUGH: shape is
 *         checked, keys are not enumerated.
 *
 * Plus the delivery half of C.2 that C.1 depends on: a SYSTEM row for a
 * SELF-HOST provider carries platform INFRASTRUCTURE, not platform SPEND, so it
 * is injectable and is NOT suppressed by the platform-default entitlement.
 * Without that, `rerank:tei` / `vector:qdrant` would be storable and undeliverable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { CLOUD_BYO_PROVIDERS, PROVIDER_SERVICES, isCloudByoProvider } from '../constants';
import { sanitizeProviderExtras, validateProviderExtras } from '../provider-extras';
import { withTask958Lookups } from './task958-repo-lookups';

const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';

function makeRow(o: {
  tenantId?: string;
  service?: string;
  provider?: string;
  enabled?: boolean;
  baseUrl?: string | null;
  encryptedApiKey?: Uint8Array | null;
  extraJson?: Record<string, unknown> | null;
}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: o.tenantId ?? TENANT_A,
    service: o.service ?? 'vector',
    provider: o.provider ?? 'qdrant',
    baseUrl: o.baseUrl ?? null,
    enabled: o.enabled ?? true,
    encryptedApiKey: o.encryptedApiKey === undefined ? Buffer.from('vault:v3:cipher', 'utf8') : o.encryptedApiKey,
    keyVersion: 3,
    extraJson: o.extraJson ?? null,
  });
}

function makeService(opts: { rowsByTenant?: Record<string, unknown[]>; entitled?: boolean } = {}) {
  const rowsByTenant = opts.rowsByTenant ?? {};
  const repo = withTask958Lookups({
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) => {
      const rows = (rowsByTenant[tenantId] ?? []) as any[];
      return rows.find((r) => r.service === service && r.provider === provider) ?? null;
    }),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      ((rowsByTenant[tenantId] ?? []) as any[]).filter((r) => r.service === service),
    ),
    findDeletedByTenantServiceProvider: vi.fn(async () => null),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  });
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT_A : undefined)) };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true), assertQuantityQuota: vi.fn() };
  const svc = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    cls as any,
    secrets as any,
    entitlements as any,
  );
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo, secrets, entitlements };
}

beforeEach(() => vi.clearAllMocks());

// ───────────────────────────── C.1 — the widened home ─────────────────────────────

describe('C.1 — the connection plane is the home for non-inference integrations too', () => {
  it('declares the integration capabilities alongside the three inference ones', () => {
    expect(PROVIDER_SERVICES).toEqual(expect.arrayContaining(['llm', 'stt', 'tts', 'embeddings', 'rerank', 'vector']));
    // Every declared service has a governance entry — the extension point is the
    // map, so a service missing from it would silently deny every tenant write.
    for (const service of PROVIDER_SERVICES) {
      expect(CLOUD_BYO_PROVIDERS[service]).toBeDefined();
    }
  });

  it('a tenant may BYO its own managed vector store; a self-host reranker stays SYSTEM-only', () => {
    expect(isCloudByoProvider('vector', 'qdrant')).toBe(true);
    // No cloud rerank adapter exists, so `rerank` is platform infrastructure:
    // a tenant row is a 403 and only the SYSTEM row serves.
    expect(isCloudByoProvider('rerank', 'tei')).toBe(false);
  });

  it('a non-LLM tenant credential round-trips ENCRYPTED and is never returned in the read DTO', async () => {
    const { svc, repo, secrets } = makeService();
    const saved = await svc.upsertRow('vector', 'qdrant', { apiKey: 'qdrant-secret', enabled: true, expectedVersion: 0 } as any, TENANT_A);

    // Stored as Vault-Transit ciphertext — never plaintext in a column.
    expect((secrets.encrypt.mock.calls[0][0] as Buffer).toString('utf8')).toBe('qdrant-secret');
    const created = repo.create.mock.calls[0][0] as any;
    expect(created.encryptedApiKey).toBeInstanceOf(Buffer);
    expect(created.encryptedApiKey.toString('utf8')).not.toContain('qdrant-secret');

    // No ciphertext and no plaintext at any depth of the response.
    expect(saved.hasKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('qdrant-secret');
    expect(JSON.stringify(saved)).not.toContain('cipher');
  });

  it('resolves that credential for ITS tenant, and never for another', async () => {
    const { svc } = makeService({ rowsByTenant: { [TENANT_A]: [makeRow({})] } });
    const mine = await svc.resolveTenantCloudOverrides('vector', TENANT_A);
    expect(mine.overrides.qdrant?.api_key).toBe('plaintext-key');

    const theirs = await svc.resolveTenantCloudOverrides('vector', TENANT_B);
    expect(theirs.overrides.qdrant).toBeUndefined();
  });

  it('the SYSTEM row serves ONLY on absence — a tenant row wins outright', async () => {
    const both = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ tenantId: TENANT_A, baseUrl: 'https://tenant.qdrant.io' })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, baseUrl: 'https://platform.qdrant.internal' })],
      },
    });
    const won = await both.svc.resolveTenantCloudOverrides('vector', TENANT_A);
    expect(won.overrides.qdrant?.base_url).toBe('https://tenant.qdrant.io');
    expect(won.overrides.qdrant?.funding).toBe('tenant');

    const systemOnly = makeService({
      rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, baseUrl: 'https://platform.qdrant.internal' })] },
    });
    const fellBack = await systemOnly.svc.resolveTenantCloudOverrides('vector', TENANT_A);
    expect(fellBack.overrides.qdrant?.base_url).toBe('https://platform.qdrant.internal');
  });

  it('funding is DERIVED from the row that supplied the credential, at both tiers', async () => {
    const tenant = makeService({ rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A })] } });
    expect((await tenant.svc.resolveTenantCloudOverrides('vector', TENANT_A)).overrides.qdrant?.funding).toBe('tenant');

    const platform = makeService({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] } });
    expect((await platform.svc.resolveTenantCloudOverrides('vector', TENANT_A)).overrides.qdrant?.funding).toBe('platform');
  });

  it('a DISABLED tenant row is a VETO of both tiers, and is reported as such', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ tenantId: TENANT_A, enabled: false })],
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })],
      },
    });
    const resolved = await svc.resolveTenantCloudOverrides('vector', TENANT_A);
    expect(resolved.overrides.qdrant).toBeUndefined();
    expect(resolved.platformDefault).toEqual({ entitlementSuppressed: false, vetoed: ['qdrant'] });

    // The by-provider cascade agrees — one veto rule, not two.
    expect(await svc.resolveConnection('vector', 'qdrant', TENANT_A)).toBeNull();
  });

  it('only the caller and SYSTEM are ever read — the "Global" customer tenant is unreachable', async () => {
    const { svc, repo } = makeService({ rowsByTenant: { [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID })] } });
    await svc.resolveTenantCloudOverrides('vector', TENANT_A);
    const tenantsRead = repo.findByTenantIdAndService.mock.calls.map((c: any[]) => c[1]);
    expect(new Set(tenantsRead)).toEqual(new Set([TENANT_A, SYSTEM_TENANT_ID]));
  });
});

// ────────────── the delivery half: platform INFRASTRUCTURE is not platform SPEND ──────────────

describe('C.1/C.2 — a SYSTEM self-host row is deliverable, and is not entitlement-gated', () => {
  it('injects a keyed SYSTEM row for a provider a tenant may NOT own (rerank:tei)', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'rerank', provider: 'tei', baseUrl: 'http://tei:8870' })],
      },
    });
    const resolved = await svc.resolveTenantCloudOverrides('rerank', TENANT_A);
    expect(resolved.overrides.tei?.base_url).toBe('http://tei:8870');
    expect(resolved.overrides.tei?.funding).toBe('platform');
  });

  it('an UNENTITLED tenant still gets platform INFRASTRUCTURE, but not the platform VENDOR account', async () => {
    const { svc } = makeService({
      entitled: false,
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [
          makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'embeddings', provider: 'tei', baseUrl: 'http://tei:8871' }),
          makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'embeddings', provider: 'openai' }),
        ],
      },
    });
    const resolved = await svc.resolveTenantCloudOverrides('embeddings', TENANT_A);
    expect(resolved.overrides.tei?.base_url).toBe('http://tei:8871');
    expect(resolved.overrides.openai).toBeUndefined();
    expect(resolved.platformDefault?.entitlementSuppressed).toBe(true);
  });

  it('a TENANT-tier row for a provider the tenant may not own is still never injected', async () => {
    const { svc } = makeService({
      rowsByTenant: { [TENANT_A]: [makeRow({ tenantId: TENANT_A, service: 'rerank', provider: 'tei' })] },
    });
    const resolved = await svc.resolveTenantCloudOverrides('rerank', TENANT_A);
    expect(resolved.overrides.tei).toBeUndefined();
  });
});

// ───────────────────── C.2 — validated passthrough, not an allow-list ─────────────────────

describe('C.2 — extraJson survives to the override entry', () => {
  it('forwards arbitrary per-endpoint quirks VERBATIM instead of dropping them', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [
          makeRow({
            service: 'llm',
            provider: 'azure',
            extraJson: {
              json_response_format: true,
              reasoning_mode: 'medium',
              no_think: false,
              adaptive_limits: true,
              max_batch: 32,
              harm_criteria: ['self_harm', 'violence'],
            },
          }),
        ],
      },
    });
    const entry = (await svc.resolveTenantCloudOverrides('llm', TENANT_A)).overrides.azure!;
    expect(entry.json_response_format).toBe(true);
    expect(entry.reasoning_mode).toBe('medium');
    expect(entry.no_think).toBe(false);
    expect(entry.adaptive_limits).toBe(true);
    expect(entry.max_batch).toBe(32);
    expect(entry.harm_criteria).toEqual(['self_harm', 'violence']);
  });

  it('keeps the model/project/location behaviour the allow-list used to provide', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [
          makeRow({ service: 'llm', provider: 'vertex', extraJson: { model: 'gemini-2.5-pro', project: 'p-1', location: 'us-central1' } }),
        ],
      },
    });
    const entry = (await svc.resolveTenantCloudOverrides('llm', TENANT_A)).overrides.vertex!;
    expect(entry.model).toBe('gemini-2.5-pro');
    expect(entry.project).toBe('p-1');
    expect(entry.location).toBe('us-central1');
  });

  it('still de-aliases the pre-unification `foundryModel`, and does not leak the old spelling', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [SYSTEM_TENANT_ID]: [
          makeRow({ tenantId: SYSTEM_TENANT_ID, service: 'stt', provider: 'openai', extraJson: { foundryModel: 'mai-transcribe-1.5' } }),
        ],
      },
    });
    const entry = (await svc.resolveTenantCloudOverrides('stt', TENANT_A)).overrides.openai!;
    expect(entry.model).toBe('mai-transcribe-1.5');
    expect(entry.foundryModel).toBeUndefined();
  });

  it('extraJson can NEVER clobber the credential, the endpoint or the derived funding label', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [
          makeRow({
            service: 'llm',
            provider: 'azure',
            baseUrl: 'https://real.endpoint',
            extraJson: { api_key: 'attacker-key', funding: 'platform', base_url: 'https://evil.endpoint', region: 'evil' },
          }),
        ],
      },
    });
    const entry = (await svc.resolveTenantCloudOverrides('llm', TENANT_A)).overrides.azure!;
    expect(entry.api_key).toBe('plaintext-key');
    expect(entry.funding).toBe('tenant');
    expect(entry.base_url).toBe('https://real.endpoint');
    expect(entry.region).toBeUndefined();
  });

  it('drops values that are not a JSON scalar or a scalar array — the wire envelope stays flat', async () => {
    const { svc } = makeService({
      rowsByTenant: {
        [TENANT_A]: [makeRow({ service: 'llm', provider: 'azure', extraJson: { nested: { a: 1 }, ok: 'yes', 'not.valid': 1 } })],
      },
    });
    const entry = (await svc.resolveTenantCloudOverrides('llm', TENANT_A)).overrides.azure!;
    expect(entry.ok).toBe('yes');
    expect(entry.nested).toBeUndefined();
    expect(entry['not.valid']).toBeUndefined();
  });

  it('an empty string is not forwarded — a blank console field means "unset", not "the empty model"', async () => {
    const { svc } = makeService({
      rowsByTenant: { [TENANT_A]: [makeRow({ service: 'llm', provider: 'azure', extraJson: { model: '', reasoning_mode: 'low' } })] },
    });
    const entry = (await svc.resolveTenantCloudOverrides('llm', TENANT_A)).overrides.azure!;
    expect(entry.model).toBeUndefined();
    expect(entry.reasoning_mode).toBe('low');
    // Accepted on write, though — clearing a field must not be a 400.
    expect(validateProviderExtras({ model: '' })).toEqual([]);
  });

  it('a prototype-polluting key is refused rather than forwarded', () => {
    const sanitized = sanitizeProviderExtras(JSON.parse('{"__proto__":{"polluted":true},"safe":1}'));
    expect(sanitized.safe).toBe(1);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(sanitized)).toEqual(['safe']);
  });
});

describe('C.2 — the WRITE path validates shape, so a bad row cannot be stored at all', () => {
  it('accepts a flat scalar/array object', () => {
    expect(validateProviderExtras({ a: 'x', b: 2, c: true, d: ['e', 'f'] })).toEqual([]);
  });

  it('rejects nesting, reserved keys, unsafe keys and oversized values', () => {
    expect(validateProviderExtras({ nested: { a: 1 } })).not.toEqual([]);
    expect(validateProviderExtras({ api_key: 'x' })).not.toEqual([]);
    expect(validateProviderExtras(JSON.parse('{"__proto__":"x"}'))).not.toEqual([]);
    expect(validateProviderExtras({ big: 'x'.repeat(5000) })).not.toEqual([]);
    expect(validateProviderExtras({ arr: Array.from({ length: 500 }, (_, i) => `${i}`) })).not.toEqual([]);
    expect(validateProviderExtras(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1])))).not.toEqual([]);
  });
});
