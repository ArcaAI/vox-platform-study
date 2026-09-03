/**
 * standalone-feature access for API keys AND service accounts.
 *
 * Owner requirement (2026-08-18): *"end-user can use service-account/api-key for
 * standalone features: speech-to-text, summarization, via SDK compat and API
 * compat"*.
 *
 * The matrix this file proves is 2 credential classes × 4 surfaces:
 *
 * | | API key (`X-API-Key`) | Service account (`X-Service-Account-Token`) |
 * |---|---|---|
 * | `audio/transcription-jobs` (native STT) | ✓ | ✓ |
 * | `api/stt/*` (compat STT) | ✓ | ✓ |
 * | `text-generations/*` (native summary) | ✓ | ✓ |
 * | `api/smr/api/v1/*` (compat summary) | ✓ | ✓ |
 *
 * ─── What "proven" means here, and what it deliberately does NOT mean ───────
 *
 * The gate under test is AUTHORIZATION, not downstream success. Three of these
 * four surfaces forward to a Python service (`apps/stt`, `apps/text`) that the
 * e2e stack treats as optional, so a green 200 is not available to assert and
 * asserting one would be a lie about what ran. The assertions are therefore:
 *
 *   - **401/403 are contract failures.** A wrong-scope credential MUST 403 with
 *     a message naming the missing scope; a right-scope credential MUST NOT get
 *     401 or 403. That is exactly the shape `task-708-apikey-scope-contract.spec.ts`
 *     uses, and it isolates the guard from the downstream.
 *   - **Anything past the gate is recorded, not asserted green.** Where the
 *     downstream is required and unavailable, the spec follows the logged-skip
 *     probe pattern of `streaming-ticket-refresh.spec.ts` — capture the reason,
 *     `console.warn` it, `test.skip` — rather than a tolerant status set that
 *     silently passes on a 500 nobody looked at.
 *
 * ─── Credentials ───────────────────────────────────────────────────────────
 *
 * The seeded `ArcaAI Tenant Automation` account carries 37 derived
 * `svc:admin:*` scopes and NONE of the three business-plane scopes this ticket
 * adds — its seed file is owned by and is not edited here (see the
 * decisions). So the service-account cases mint their own account
 * through `POST /admin/service-accounts` as SUPER_ADMIN, which is also the
 * honest end-to-end path: create → exchange → present the opaque token.
 *
 * Live-stack requirement: none for the gate assertions. Invoke with
 * `RESET_DB=false pnpm test:e2e task-767` (the DB is already seeded).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SA_BASE = '/api/v1/admin/service-accounts';
const EXCHANGE = '/api/v1/auth/service-token';

/** The tenant both credential classes act on. Seeded, and the seeded service account's home. */
const ARCAAI_TENANT_KEY = 'ARCAAI';

// The four standalone surfaces, at their canonical paths. The two compat ones
// are prefix-EXCLUDED in `main.ts`, so they carry no `/api/v1`.
const NATIVE_STT = '/api/v1/audio/transcription-jobs';
const COMPAT_STT_START = '/api/stt/start_session';
const NATIVE_SUMMARY = '/api/v1/text-generations/generate';
/**
 * Per-request budget for calls that wait on a real model. `APIRequestContext`
 * caps every request at 30s by default, which a busy local provider exceeds —
 * these tests assert the AUTH outcome, not latency (see playwright.config.ts).
 */
const INFERENCE_REQUEST_TIMEOUT_MS = 230_000;

const COMPAT_SUMMARY = '/api/smr/api/v1/summary/sync';

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

interface CreatedServiceAccount {
  id: string;
  clientId: string;
  clientSecret: string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Mint an API key with exactly `scopes`, owned by the caller's own tenant. */
async function createScopedApiKey(request: APIRequestContext, token: string, scopes: string[], namePrefix: string): Promise<CreatedApiKey> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: bearer(token),
    data: { keyName: `${namePrefix}-${Date.now()}`, keyType: 'SDK', scopes },
  });
  expect(response.status(), `API key creation failed for ${namePrefix}: ${await response.text()}`).toBe(201);
  const body = await response.json();
  return { id: body.apiKey.id, rawKey: body.rawKey };
}

/** Issue a service account with exactly `scopes` and exchange its secret for a token. */
async function createServiceAccountToken(
  request: APIRequestContext,
  superAdminToken: string,
  scopes: string[],
  namePrefix: string,
): Promise<{ account: CreatedServiceAccount; accessToken: string }> {
  const created = await request.post(SA_BASE, {
    headers: bearer(superAdminToken),
    data: { displayName: `${namePrefix}-${Date.now()}`, scopes },
  });
  expect(created.status(), `service-account creation failed for ${namePrefix}: ${await created.text()}`).toBe(201);
  const account = (await created.json()) as CreatedServiceAccount;

  const exchange = await request.post(EXCHANGE, { data: { clientId: account.clientId, clientSecret: account.clientSecret } });
  expect(exchange.status(), `token exchange failed for ${namePrefix}: ${await exchange.text()}`).toBe(200);
  const { accessToken } = (await exchange.json()) as { accessToken: string };
  return { account, accessToken };
}

/**
 * A schema-valid v1 body for the compat summarization surface — the SAME shape
 * `task-562-text-compat.spec.ts` sends, so a 400 here would mean the frozen
 * contract moved, never that this spec guessed the payload wrong.
 */
const compatSummaryBody = () => ({
  session_data: {
    session_id: `task-767-${Date.now()}`,
    created_at: new Date().toISOString(),
    conversation_segments: [
      { speaker: 'provider', text: 'What brings you in today?', timestamp: new Date().toISOString() },
      { speaker: 'patient', text: 'Chest tightness since Monday.', timestamp: new Date().toISOString(), confidence: 0.94 },
    ],
    session_metadata: { language: 'en' },
  },
  use_enhanced_format: false,
  temperature: 0.2,
  max_tokens: 256,
});

test.describe('standalone features reachable by both machine credential classes', () => {
  let adminToken: string;
  let superAdminToken: string;
  const createdApiKeyIds: string[] = [];
  const createdAccountIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const [admin, superAdmin] = await Promise.all([
      loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
      // The SUPER_ADMIN logs in ON the ArcaAI tenant so the account it issues is
      // tenant-bound there; a super admin with an empty tenant would land the
      // account on SYSTEM, which is a config TIER, not a place to act from.
      loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, ARCAAI_TENANT_KEY),
    ]);
    expect(admin, 'tenant_admin login failed — is the API seeded and running on :8968?').not.toBeNull();
    expect(superAdmin, 'super_admin login failed').not.toBeNull();
    adminToken = admin!.token;
    superAdminToken = superAdmin!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdApiKeyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: bearer(adminToken) });
    }
    for (const id of createdAccountIds) {
      await request.delete(`${SA_BASE}/${id}`, { headers: bearer(superAdminToken) });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The premise: before this ticket a service account reached NOTHING here.
  // ───────────────────────────────────────────────────────────────────────────

  test('a machine token still reaches nothing it was not granted — deny-by-default is intact', async ({ request }) => {
    const { account, accessToken } = await createServiceAccountToken(
      request,
      superAdminToken,
      ['svc:admin:department:manage'],
      'task-767-wrong-scope',
    );
    createdAccountIds.push(account.id);

    // An ADMIN-plane scope must not open a BUSINESS-plane surface.
    const response = await request.get(NATIVE_STT, { headers: { 'X-Service-Account-Token': accessToken } });
    expect(response.status(), 'svc:admin:department:manage must not reach the STT job surface').toBe(403);
    expect(await response.text()).toContain('svc:stt:transcription:write');
  });

  test('an unscoped route still refuses every machine token — no route declares svc scopes by accident', async ({ request }) => {
    const { account, accessToken } = await createServiceAccountToken(
      request,
      superAdminToken,
      ['svc:stt:transcription:write'],
      'task-767-undeclared',
    );
    createdAccountIds.push(account.id);

    // `/consultations` is a business-plane surface this ticket deliberately did
    // NOT open to machines. It must stay a 403, not fall through to CASL.
    const response = await request.get('/api/v1/consultations', { headers: { 'X-Service-Account-Token': accessToken } });
    expect(response.status(), 'an undeclared route must refuse a machine token').toBe(403);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 1 — native speech-to-text (`audio/transcription-jobs`)
  // ───────────────────────────────────────────────────────────────────────────

  test.describe('native STT — /audio/transcription-jobs', () => {
    test('API key: an stt:transcription:write key passes the gate', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['stt:transcription:write'], 'task-767-native-stt-key');
      createdApiKeyIds.push(key.id);

      const response = await request.get(NATIVE_STT, { headers: { 'X-API-Key': key.rawKey } });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: an svc:stt:transcription:write token passes the gate', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:stt:transcription:write'],
        'task-767-native-stt-svc',
      );
      createdAccountIds.push(account.id);

      const response = await request.get(NATIVE_STT, { headers: { 'X-Service-Account-Token': accessToken } });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('API key: a wrong-scope key is 403 naming the scope it lacks', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-767-native-stt-denied');
      createdApiKeyIds.push(key.id);

      const response = await request.get(NATIVE_STT, { headers: { 'X-API-Key': key.rawKey } });
      expect(response.status()).toBe(403);
      expect((await response.json()).message).toContain('stt:transcription:write');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 2 — compat speech-to-text (`api/stt/*`, frozen v1 wire contract)
  // ───────────────────────────────────────────────────────────────────────────

  test.describe('compat STT — /api/stt/start_session', () => {
    const startBody = () => ({
      session_id: `task-767-${Date.now()}`,
      audioSettings: {
        sampleRate: 16000,
        format: 'pcm' as const,
        channels: 1 as const,
        bitDepth: 16 as const,
        chunkSize: 1024,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: false,
      },
    });

    test('the frozen path still resolves and still requires a credential', async ({ request }) => {
      const unauth = await request.post(COMPAT_STT_START, { data: startBody(), maxRedirects: 0 });
      expect(unauth.status(), 'the literal v1 path must exist and require auth').toBe(401);

      const prefixed = await request.post(`/api/v1${COMPAT_STT_START}`, { data: startBody() });
      expect(prefixed.status(), 'the v1 path is prefix-EXCLUDED; the prefixed form must not exist').toBe(404);
    });

    test('API key: an stt:stream:write key passes the gate', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['stt:stream:write'], 'task-767-compat-stt-key');
      createdApiKeyIds.push(key.id);

      const response = await request.post(COMPAT_STT_START, { headers: { 'X-API-Key': key.rawKey }, data: startBody() });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: an svc:stt:stream:write token passes the gate', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(request, superAdminToken, ['svc:stt:stream:write'], 'task-767-compat-stt-svc');
      createdAccountIds.push(account.id);

      const response = await request.post(COMPAT_STT_START, { headers: { 'X-Service-Account-Token': accessToken }, data: startBody() });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: a summarization-scoped token does NOT reach STT', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:consultation:report:write'],
        'task-767-compat-stt-denied',
      );
      createdAccountIds.push(account.id);

      const response = await request.post(COMPAT_STT_START, { headers: { 'X-Service-Account-Token': accessToken }, data: startBody() });
      expect(response.status()).toBe(403);
      expect(await response.text()).toContain('svc:stt:stream:write');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 3 — native summarization (`text-generations`)
  // ───────────────────────────────────────────────────────────────────────────

  test.describe('native summarization — /text-generations/generate', () => {
    const generateBody = () => ({ prompt: 'Summarize: patient reports chest tightness since Monday.', max_tokens: 32 });

    test('API key: a consultation:report:write key passes the gate', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-767-native-sum-key');
      createdApiKeyIds.push(key.id);

      const response = await request.post(NATIVE_SUMMARY, { headers: { 'X-API-Key': key.rawKey }, data: generateBody() });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: an svc:consultation:report:write token passes the gate', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:consultation:report:write'],
        'task-767-native-sum-svc',
      );
      createdAccountIds.push(account.id);

      const response = await request.post(NATIVE_SUMMARY, { headers: { 'X-Service-Account-Token': accessToken }, data: generateBody() });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: an STT-scoped token does NOT reach summarization', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:stt:transcription:write'],
        'task-767-native-sum-denied',
      );
      createdAccountIds.push(account.id);

      const response = await request.post(NATIVE_SUMMARY, { headers: { 'X-Service-Account-Token': accessToken }, data: generateBody() });
      expect(response.status()).toBe(403);
      expect(await response.text()).toContain('svc:consultation:report:write');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 4 — compat summarization (`api/smr/api/v1`, frozen v1 wire contract)
  // ───────────────────────────────────────────────────────────────────────────

  test.describe('compat summarization — /api/smr/api/v1/summary/sync', () => {
    test('the frozen path still resolves and still requires a credential', async ({ request }) => {
      const unauth = await request.post(COMPAT_SUMMARY, { data: compatSummaryBody(), maxRedirects: 0 });
      expect(unauth.status(), 'the literal v1 path must exist and require auth').toBe(401);

      const prefixed = await request.post(`/api/v1${COMPAT_SUMMARY}`, { data: compatSummaryBody() });
      expect(prefixed.status(), 'the v1 path is prefix-EXCLUDED; the prefixed form must not exist').toBe(404);
    });

    test('API key: a consultation:report:write key passes the gate', async ({ request }) => {
      const key = await createScopedApiKey(request, adminToken, ['consultation:report:write'], 'task-767-compat-sum-key');
      createdApiKeyIds.push(key.id);

      const response = await request.post(COMPAT_SUMMARY, {
        headers: { 'X-API-Key': key.rawKey },
        data: compatSummaryBody(),
        timeout: INFERENCE_REQUEST_TIMEOUT_MS,
      });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });

    test('service account: an svc:consultation:report:write token passes the gate', async ({ request }) => {
      const { account, accessToken } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:consultation:report:write'],
        'task-767-compat-sum-svc',
      );
      createdAccountIds.push(account.id);

      const response = await request.post(COMPAT_SUMMARY, {
        headers: { 'X-Service-Account-Token': accessToken },
        data: compatSummaryBody(),
        timeout: INFERENCE_REQUEST_TIMEOUT_MS,
      });
      expect(response.status(), await response.text()).not.toBe(401);
      expect(response.status(), await response.text()).not.toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Downstream reachability — recorded, never asserted green.
  // ───────────────────────────────────────────────────────────────────────────

  test.describe('end-to-end past the gate (needs apps/text)', () => {
    let accessToken = '';
    let skipReason = '';

    test.beforeAll(async ({ request }) => {
      const { account, accessToken: issued } = await createServiceAccountToken(
        request,
        superAdminToken,
        ['svc:consultation:report:write'],
        'task-767-e2e-downstream',
      );
      createdAccountIds.push(account.id);
      accessToken = issued;
    });

    test('a machine token drives compat summarization all the way to a v1 body', async ({ request }) => {
      const response = await request.post(COMPAT_SUMMARY, {
        headers: { 'X-Service-Account-Token': accessToken },
        data: compatSummaryBody(),
        timeout: INFERENCE_REQUEST_TIMEOUT_MS,
      });

      // The gate is asserted unconditionally — that part never depends on a
      // Python service being up.
      expect(response.status(), 'authorization must not be the failure').not.toBe(401);
      expect(response.status(), 'authorization must not be the failure').not.toBe(403);

      if (response.status() !== 200) {
        skipReason = `POST ${COMPAT_SUMMARY} returned ${response.status()} — is apps/text (TEXT_URL) running? body: ${(await response.text()).slice(0, 300)}`;
        console.warn(`[] ${skipReason}`);
      }
      test.skip(response.status() !== 200, skipReason);

      const body = await response.json();
      expect(body.session_id, 'the v1 response shape is unchanged').toBeTruthy();
    });
  });
});
