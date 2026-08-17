/**
 * Model-cache retention TTL — settings-registry write lane → effective-config
 * read round trip (gap).
 *
 * `settings-registry-write.spec.ts` proves the write lane's generic
 * enforcement (unknown key, type mismatch, unwritable tier, globalOnly 403) and
 * that the retention keys are CATALOGED. It never PUTs one of the retention
 * TTLs and checks that the write actually reaches the effective-config read
 * side — that is this spec.
 *
 * There is no single `models.retention.ttlSeconds` key — deliberately, per
 * `model-retention.descriptors.test.ts` ("does NOT introduce a competing
 * models.retention.* namespace"): the family is `<service>.modelCache.
 * ttlSeconds` for `stt|nlp|guardrail|harness|tts`, plus the SMR-only
 * `smr.modelCache.ttlSeconds` (SMR holds no weights, so it has no
 * maxModels/vramBudgetMb — ttlSeconds is its only retention field). This spec
 * exercises `smr.modelCache.ttlSeconds` as the representative of that family.
 *
 * IMPORTANT — where the [60s, 3600s] clamp mentioned on the descriptor
 * actually lives: `service-runtime.descriptors.ts` documents "the service
 * re-applies its own product clamp (min 60s / max 3600s)" — that clamp is
 * enforced by the CONSUMING PYTHON SERVICE when it loads the value, not by
 * this gateway. `SettingsRegistryWriteService#serialize` only checks the
 * `dataType` (`number`), and `EffectiveConfigService` forwards whatever is
 * stored, unclamped (verified by reading both files — neither contains a
 * numeric range check). So the gateway-level, honest version of "out-of-range
 * values clamp" is: the WRITE is accepted and the READ reflects it verbatim;
 * the range clamp itself is downstream-only and out of this spec's reach
 * without standing up the consuming service.
 *
 * Live-stack requirement: dev/test stack + seed (`pnpm test:api:up` +
 * `pnpm test:e2e`). The retention key is SYSTEM-scoped shared platform state
 * (`maxScope: 'system'`, `globalOnly: true`), so every test reads the CURRENT
 * version fresh immediately before writing (never a value cached from an
 * earlier test) — the same self-healing style `mcp-admin.spec.ts` and
 * `agentic-policy.spec.ts` use for their own shared-row OCC sequences. The
 * original value is captured in `beforeAll` and restored in `afterAll` so no
 * other suite (or a developer's persistent local stack) observes a changed
 * default.
 *
 * The internal `/api/v1/internal/effective-config` read is service-token
 * gated (`InternalServiceTokenGuard`) and no `*_SERVICE_TOKEN` secret is
 * configured in `.env.test` by default, so that half is ENV-GATED and skipped
 * unless the operator sets `E2E_TEXT_SERVICE_TOKEN` to the same value
 * configured as `TEXT_SERVICE_TOKEN` on the running gateway (mirrors the
 * `HARNESS_SERVICE_TOKEN` gating pattern in `harness-gate.spec.ts`). The
 * always-on half of this spec uses the admin effective read
 * (`GET admin/settings/registry/:key`), which needs no such token.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const REGISTRY_KEY = 'smr.modelCache.ttlSeconds';
const REGISTRY_ROUTE = `/api/v1/admin/settings/registry/${REGISTRY_KEY}`;
const INTERNAL_EFFECTIVE_CONFIG = '/api/v1/internal/effective-config?service=smr';

const TEXT_SERVICE_TOKEN = process.env.E2E_TEXT_SERVICE_TOKEN ?? process.env.E2E_TEXT_V2_SERVICE_TOKEN ?? '';

interface RegistrySettingBody {
  key: string;
  tier: string;
  value: number;
  sourceScope: string;
  version: number;
}

interface EffectiveConfigBody {
  service: string;
  retention?: { ttlSeconds: number | null; source: string };
}

test.describe('model-cache retention TTL — write lane reaches the effective-config read side', () => {
  // Every test in this describe read-modify-writes the SAME SYSTEM-scoped
  // singleton row. Under the root config's `fullyParallel: true`, two workers
  // can read the same `_version` and the loser gets a spurious 412 — so this
  // describe must run serially.
  test.describe.configure({ mode: 'serial' });

  let superAdminToken: string;
  let originalValue: number;

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  async function readKey(request: APIRequestContext): Promise<RegistrySettingBody> {
    const resp = await request.get(REGISTRY_ROUTE, { headers: auth() });
    expect(resp.status(), `GET ${REGISTRY_ROUTE}`).toBe(200);
    return (await resp.json()) as RegistrySettingBody;
  }

  /** Always reads the CURRENT version immediately before writing — never a value cached from an earlier test. */
  async function writeKey(request: APIRequestContext, value: unknown) {
    const current = await readKey(request);
    return request.put(REGISTRY_ROUTE, {
      headers: { ...auth(), 'If-Match': `"${current.version}"` },
      data: { value },
    });
  }

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'super admin login failed').toBeTruthy();
    superAdminToken = login!.token;

    originalValue = (await readKey(request)).value;
  });

  test.afterAll(async ({ request }) => {
    const current = await readKey(request);
    if (current.value === originalValue) return;
    await writeKey(request, originalValue).catch(() => undefined);
  });

  test('an in-range write round-trips through the admin effective read', async ({ request }) => {
    const before = await readKey(request);
    const testValue = before.value === 900 ? 950 : 900;

    const put = await writeKey(request, testValue);
    expect(put.status()).toBe(200);

    const after = await readKey(request);
    expect(after.value).toBe(testValue);
    expect(after.tier).toBe('global-kv');
    // sourceScope names WHICH row answered the tenant->SYSTEM->code-default
    // cascade ('tenant' | 'system' | 'code-default'), not the descriptor's
    // tier — a platform-scoped write (no tenant override) resolves 'system'.
    // See TenantSettingsService.resolve() (packages/applications/src/services/
    // settings-registry/tenant-settings.service.ts).
    expect(after.sourceScope).toBe('system');
  });

  test('a below-minimum write (< 60s) is accepted verbatim — the clamp is enforced downstream, not by this gateway', async ({ request }) => {
    const put = await writeKey(request, 30);
    expect(put.status()).toBe(200);

    const after = await readKey(request);
    expect(after.value).toBe(30);
  });

  test('an above-maximum write (> 3600s) is accepted verbatim — the clamp is enforced downstream, not by this gateway', async ({ request }) => {
    const put = await writeKey(request, 5000);
    expect(put.status()).toBe(200);

    const after = await readKey(request);
    expect(after.value).toBe(5000);
  });

  test('a non-number value is still rejected 400 (the write lane DOES enforce dataType, just not range)', async ({ request }) => {
    const resp = await writeKey(request, 'not-a-number');
    expect(resp.status()).toBe(400);
  });

  test.describe('internal effective-config read (env-gated)', () => {
    test.skip(
      !TEXT_SERVICE_TOKEN,
      'requires E2E_TEXT_SERVICE_TOKEN set to the same value as the running gateway’s TEXT_SERVICE_TOKEN secret ' +
        '(the InternalServiceTokenGuard fails closed with no configured secret — see the file header)',
    );

    test('the written value reaches GET internal/effective-config?service=smr', async ({ request }) => {
      const before = await readKey(request);
      const testValue = before.value === 601 ? 602 : 601;
      const put = await writeKey(request, testValue);
      expect(put.status()).toBe(200);

      const resp = await request.get(INTERNAL_EFFECTIVE_CONFIG, { headers: { 'X-Service-Token': TEXT_SERVICE_TOKEN } });
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as EffectiveConfigBody;
      expect(body.service).toBe('smr');
      expect(body.retention?.ttlSeconds).toBe(testValue);
      expect(body.retention?.source).toBe('db');
    });

    test('an invalid X-Service-Token is rejected 401 (fail-closed)', async ({ request }) => {
      const resp = await request.get(INTERNAL_EFFECTIVE_CONFIG, { headers: { 'X-Service-Token': 'definitely-not-the-secret' } });
      expect(resp.status()).toBe(401);
    });
  });
});
