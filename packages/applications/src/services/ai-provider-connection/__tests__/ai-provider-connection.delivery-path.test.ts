/**
 * The two DELIVERY PATHS a connection row can take, pinned on ONE row.
 *
 * This is the landmine TASK-799 Round 2 recorded and lane H was asked to make
 * un-trippable. Stated plainly:
 *
 *   | Path                                   | Keyless row?                    |
 *   |----------------------------------------|---------------------------------|
 *   | `resolveConnection(service, provider,  | RESOLVES. A direct TypeScript   |
 *   |  tenantId)`                            | call; returns the row, key or   |
 *   |                                        | no key.                         |
 *   | `resolveTenantCloudOverrides(...)`     | DROPPED. The fold skips         |
 *   | → the `provider_overrides` FOLD, which | `!enabled \|\| !encryptedApiKey` |
 *   | is what `apps/text` / `apps/tts` / the | on BOTH tiers, by design.       |
 *   | STT config service actually read       |                                 |
 *
 * Both halves are already asserted elsewhere — `resolveTenantCloudOverrides`
 * cases 5/6 in `ai-provider-connection.platform-default.test.ts`, and
 * `resolveConnection` case 10b in the same file. But they are asserted on
 * DIFFERENT rows, in different `describe` blocks, which is exactly how the trap
 * survives: each half reads as a local property of its own test, and nobody sees
 * that ONE row answers "yes" to one question and "no" to the other.
 *
 * WHY IT MATTERS CONCRETELY. The seed deliberately does NOT create `rerank:tei`
 * or `vector:qdrant` SYSTEM rows, because their only consumer
 * (`apps/harness`'s retrieval stack) reaches NEITHER path: it holds no DB handle
 * (so `resolveConnection` is unreachable), it runs inside a Temporal activity
 * (so there is no gateway request to inject into), and `EffectiveConfigResponse`
 * carries no `connections` block. Seeding a keyless row there would look correct
 * in the seed, resolve correctly in a REPL, and deliver nothing — a silent no-op
 * that reads as done. See `seed/17-ai-provider-connection.ts` §"Why a keyless
 * row is not enough" and `apps/harness/src/harness/core/config.py` §"Why the
 * endpoints below are still env".
 *
 * So: one row, both questions, one file. Read the table above before adding a
 * SYSTEM row for a new self-hosted integration.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT_A = 'tenant-aaa';

/** A SYSTEM row for a platform-run self-host endpoint, keyed or keyless. */
function systemRow(opts: { service: string; provider: string; baseUrl: string; keyed: boolean }) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service: opts.service,
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    region: null,
    enabled: true,
    encryptedApiKey: opts.keyed ? Buffer.from('vault:v3:cipher', 'utf8') : null,
    keyVersion: opts.keyed ? 3 : null,
    extraJson: null,
  });
}

function makeService(rows: unknown[]) {
  const repo = {
    findByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) =>
      (rows as any[]).find((r) => r.service === service && r.provider === provider && r.tenantId === tenantId) ?? null,
    ),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      (rows as any[]).filter((r) => r.service === service && r.tenantId === tenantId),
    ),
    create: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
  };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const svc = new AiProviderConnectionService(
    repo as any,
    { baseClient: {} } as any,
    { emit: vi.fn() } as any,
    { get: vi.fn(() => undefined) } as any,
    secrets as any,
    { isFeatureEnabled: vi.fn(async () => true) } as any,
  );
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return svc;
}

beforeEach(() => vi.clearAllMocks());

describe('a KEYLESS SYSTEM row — resolvable, but never delivered', () => {
  // `vector:qdrant` is the specimen on purpose: the platform Qdrant needs no
  // credential, and `qdrant` IS cloud-BYO eligible, so every intuition says a
  // keyless SYSTEM row here is complete. It is not.
  const keyless = () => makeService([systemRow({ service: 'vector', provider: 'qdrant', baseUrl: 'http://localhost:6333', keyed: false })]);

  it('RESOLVES through `resolveConnection` — a tenant with no opinion gets the platform endpoint', async () => {
    await expect(keyless().resolveConnection('vector', 'qdrant', TENANT_A)).resolves.toMatchObject({
      baseUrl: 'http://localhost:6333',
      source: 'system',
    });
  });

  it('is ABSENT from `provider_overrides` — the key guard, not the provider list, is what drops it', async () => {
    const { overrides } = await keyless().resolveTenantCloudOverrides('vector', TENANT_A);
    expect(overrides).toEqual({});
  });

  it('so the two answers DISAGREE for one row — that disagreement is the contract, not a bug', async () => {
    const svc = keyless();
    const resolved = await svc.resolveConnection('vector', 'qdrant', TENANT_A);
    const { overrides } = await svc.resolveTenantCloudOverrides('vector', TENANT_A);

    expect(resolved).not.toBeNull();
    expect(overrides['qdrant']).toBeUndefined();
  });
});

describe('the SAME row, KEYED — now both paths carry it', () => {
  const keyed = () => makeService([systemRow({ service: 'vector', provider: 'qdrant', baseUrl: 'http://localhost:6333', keyed: true })]);

  it('resolves, AND appears in `provider_overrides` labelled platform-funded', async () => {
    const svc = keyed();
    await expect(svc.resolveConnection('vector', 'qdrant', TENANT_A)).resolves.toMatchObject({ source: 'system' });

    const { overrides } = await svc.resolveTenantCloudOverrides('vector', TENANT_A);
    expect(overrides['qdrant']).toMatchObject({ base_url: 'http://localhost:6333', funding: 'platform' });
  });

  it('is the whole reason the seed gives keyless ENGINES the `not-needed` placeholder', async () => {
    // `apps/text` reads `provider_overrides[provider]` and raises
    // `ProviderConnectionMissingError` → 503 when it is absent, with no env
    // fallback. So a self-hosted engine that needs no auth must still carry key
    // material, or every request for it 503s. `seed/17-ai-provider-connection.ts`
    // seeds `SELF_HOST_PLACEHOLDER_API_KEY` for exactly this reason.
    const svc = makeService([systemRow({ service: 'llm', provider: 'lm-studio', baseUrl: 'http://localhost:1234/v1', keyed: true })]);
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT_A);
    expect(overrides['lm-studio']).toBeDefined();
  });
});
