/**
 * TASK-934 (G-1/G-3, lane A) — the admin write path for `AiModel._metadata.asr`
 * (`asrProfile` on `PATCH admin/ai-models/:id`).
 *
 * DEPTH the route-authz matrix cannot express: `admin/ai-models/:id` already
 * carries `manage:all` + OCC coverage in the matrix/credential specs. What is
 * new here is the FIELD's own semantics — round-trips through
 * `parseAiModelAsrProfile`, is refused on any row but an
 * `AUTOMATIC_SPEECH_RECOGNITION` one, and range-validates the same table the
 * gateway resolver (`buildResolvedAsrSpec`) reads with.
 *
 * The test mutates the seeded `arcaai-whisper-large-ml-en-gguf-q8_0` row and
 * restores it before returning — never hardcode the "before" profile: read it
 * fresh and write it back, because lane D may have re-seeded the window
 * geometry (§2.5/§4 OD-1) by the time this runs.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const AI_MODELS = '/api/v1/admin/ai-models';
/** ml-en fine-tune, `AUTOMATIC_SPEECH_RECOGNITION` — the row lane P's resolver reads `_metadata.asr` off. */
const ASR_MODEL_SLUG = 'arcaai-whisper-large-ml-en-gguf-q8_0';
/** `VOICE_ACTIVITY_DETECTION` — any row whose task is not ASR proves the 400. */
const NON_ASR_MODEL_SLUG = 'silero-vad';

interface AsrProfile {
  maxDecodeWindowSec?: number;
  partialWindowSec?: number;
  decoding?: Record<string, unknown>;
  initialPrompt?: string;
}

interface ModelRow {
  id: string;
  slug: string;
  taskType: string;
  version: number;
  asrProfile: AsrProfile | null;
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function fetchBySlug(request: APIRequestContext, token: string, slug: string): Promise<{ status: number; body: ModelRow }> {
  const res = await request.get(`${AI_MODELS}/slug/${slug}`, { headers: auth(token) });
  return { status: res.status(), body: (await res.json()) as ModelRow };
}

test.describe('TASK-934 — asrProfile on PATCH admin/ai-models/:id', () => {
  test('super admin writes the profile, GET echoes it parsed, then the row is restored', async ({ request }) => {
    const token = await superAdminToken(request);

    // 1. Read the CURRENT row — id, OCC version and whatever profile it already
    //    carries — never hardcoded (see file docblock).
    const before = await fetchBySlug(request, token, ASR_MODEL_SLUG);
    expect(before.status, 'the seeded ml-en q8_0 row must exist').toBe(200);
    const { id, version: originalVersion, asrProfile: originalProfile } = before.body;

    // 2. Write the candidate profile the ticket measured (§2.2/§2.5): a 7s final
    //    window, a 15s partial tail, and a raised no-speech floor.
    const candidate: AsrProfile = { maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } };
    const write = await request.patch(`${AI_MODELS}/${id}`, {
      headers: { ...auth(token), 'If-Match': `"${originalVersion}"` },
      data: { asrProfile: candidate, expectedVersion: originalVersion },
    });
    expect(write.status(), await write.text()).toBe(200);
    const written = (await write.json()) as ModelRow;
    expect(written.asrProfile).toEqual(candidate);
    expect(written.version).toBe(originalVersion + 1);

    // 3. GET echoes the PARSED profile — the same shape `parseAiModelAsrProfile`
    //    hands the gateway resolver, not the raw stored JSON.
    const after = await fetchBySlug(request, token, ASR_MODEL_SLUG);
    expect(after.status).toBe(200);
    expect(after.body.asrProfile).toEqual(candidate);

    // 4. Restore — the seeded row is shared state; leaving it mutated would
    //    break whatever runs against this DB next (RESET_DB=false-safe).
    const restore = await request.patch(`${AI_MODELS}/${id}`, {
      headers: { ...auth(token), 'If-Match': `"${written.version}"` },
      data: { asrProfile: originalProfile ?? null, expectedVersion: written.version },
    });
    expect(restore.status(), 'restore PATCH must succeed so the test is repeatable').toBe(200);
    const restored = (await restore.json()) as ModelRow;
    expect(restored.asrProfile).toEqual(originalProfile ?? null);
  });

  test('missing If-Match → 428', async ({ request }) => {
    const token = await superAdminToken(request);
    const { body } = await fetchBySlug(request, token, ASR_MODEL_SLUG);

    const res = await request.patch(`${AI_MODELS}/${body.id}`, {
      headers: auth(token),
      data: { asrProfile: { maxDecodeWindowSec: 7 }, expectedVersion: body.version },
    });
    expect(res.status()).toBe(428);
  });

  test('stale If-Match → 412', async ({ request }) => {
    const token = await superAdminToken(request);
    const { body } = await fetchBySlug(request, token, ASR_MODEL_SLUG);

    const res = await request.patch(`${AI_MODELS}/${body.id}`, {
      headers: { ...auth(token), 'If-Match': `"${body.version + 99}"` },
      data: { asrProfile: { maxDecodeWindowSec: 7 }, expectedVersion: body.version + 99 },
    });
    expect(res.status()).toBe(412);
  });

  test('a tenant admin gets 403 on the SYSTEM-tier row — a privilege boundary, not 404-over-403', async ({ request }) => {
    const superToken = await superAdminToken(request);
    const { body } = await fetchBySlug(request, superToken, ASR_MODEL_SLUG);

    const tenantToken = await tenantAdminToken(request);
    const res = await request.patch(`${AI_MODELS}/${body.id}`, {
      headers: { ...auth(tenantToken), 'If-Match': `"${body.version}"` },
      data: { asrProfile: { maxDecodeWindowSec: 7 }, expectedVersion: body.version },
    });
    expect(res.status()).toBe(403);
  });

  test('asrProfile on a non-ASR row → 400, naming the field', async ({ request }) => {
    const token = await superAdminToken(request);
    const { body } = await fetchBySlug(request, token, NON_ASR_MODEL_SLUG);
    expect(body.taskType, 'the fixture row must not be ASR').not.toBe('AUTOMATIC_SPEECH_RECOGNITION');

    const res = await request.patch(`${AI_MODELS}/${body.id}`, {
      headers: { ...auth(token), 'If-Match': `"${body.version}"` },
      data: { asrProfile: { maxDecodeWindowSec: 7 }, expectedVersion: body.version },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('asrProfile');
  });

  test('an out-of-range decoding value → 400 (DTO fails closed, unlike the lenient runtime parser)', async ({ request }) => {
    const token = await superAdminToken(request);
    const { body } = await fetchBySlug(request, token, ASR_MODEL_SLUG);

    const res = await request.patch(`${AI_MODELS}/${body.id}`, {
      headers: { ...auth(token), 'If-Match': `"${body.version}"` },
      data: { asrProfile: { decoding: { noSpeechThreshold: 1.5 } }, expectedVersion: body.version },
    });
    expect(res.status()).toBe(400);
  });
});
