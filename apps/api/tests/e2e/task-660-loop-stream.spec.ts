/**
 * Live-stack probes against the consultation-loop SSE plane.
 *
 * `GET /consultations/:id/loop/stream` was shipped with unit coverage only: its
 * relay/heartbeat behaviour is asserted with fake timers, and its 404-over-403
 * posture is asserted by reading `@TenantOwnedResource` decorator METADATA
 * . Nothing had ever exercised the route over HTTP
 * OP-2 /. This spec is that wire proof, and it covers the three claims
 * the metadata assertion cannot reach:
 *
 *   1. **The tenant guard actually fires.** A caller in tenant ARCAAI probing a
 *      `__GLOBAL__`-owned consultation is refused BEFORE the stream opens, with
 *      no tenant wording in the body, and a synthetic id is indistinguishable
 *      from it (DEF-C3 no-existence-leak).
 *   2. **Events relay.** A `LoopEventDto` POSTed to the internal
 *      `POST /internal/harness/consultations/:id/loop-event` endpoint comes back
 *      out of the browser-facing stream verbatim.
 *   3. **The heartbeat fires.** The merged `heartbeat$` really emits on the
 *      wire at `TRAJECTORY_HEARTBEAT_MS` (15s), so an idle stream is not a dead
 *      one.
 *
 * The sibling streams (`harness-progress`, `assurance`, `trajectory`) are
 * probed for the same pre-stream 404 so the whole SSE plane is covered by one
 * spec rather than only the newest route.
 *
 * Playwright's `APIRequestContext` cannot be used for (2) and (3): a 200 SSE
 * response never completes, so `request.get` would hang until the test timeout.
 * Those two tests use `fetch` + a `ReadableStream` reader with an
 * `AbortController`, which is the only way to observe a stream incrementally.
 *
 * Live-stack requirement: seeded test stack (`pnpm infra:test:up`,
 * `pnpm test:db:seed`) + `pnpm test:up:api`. Redis must be up — the relay is a
 * genuine Redis pub/sub round trip. The harness worker is NOT needed: the
 * internal endpoint is the publisher, so no Temporal involvement.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** Seeded `__GLOBAL__` consultation owned by the `doctor` user. */
const GLOBAL_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';
/** Seeded ARCAAI-owned consultation — the far side of the tenant boundary. */
const ARCAAI_CONSULTATION_ID = '90000000-0000-0000-0001-000000000001';
/** uuidv7-shaped id no tenant has ever seen. */
const SYNTHETIC_CONSULTATION_ID = '018f0000-0000-7000-8000-000000000660';

/** `arcaai_admin` is the ARCAAI-scoped TENANT_ADMIN; it is not in SEEDED_USERS. */
const ARCAAI_ADMIN_USERNAME = 'arcaai_admin';
const ARCAAI_TENANT_KEY = 'ARCAAI';
const SEED_PASSWORD = 'password123';

const API_ORIGIN = process.env.API_URL || 'http://localhost:8968';
/** Matches `ConsultationController.TRAJECTORY_HEARTBEAT_MS`. */
const HEARTBEAT_MS = 15_000;

interface SseEvent {
  type?: string;
  kind?: string;
  [key: string]: unknown;
}

/**
 * Open an SSE stream and resolve once `predicate` matches a decoded event (or
 * the budget expires). Always aborts the request, so a passing test never
 * leaves the Redis subscription open.
 */
async function readSseUntil(
  url: string,
  headers: Record<string, string>,
  predicate: (event: SseEvent) => boolean,
  budgetMs: number,
): Promise<{ status: number; matched: SseEvent | null; seen: SseEvent[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const seen: SseEvent[] = [];

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status !== 200 || !response.body) {
      return { status: response.status, matched: null, seen };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; each carries `data: <json>`.
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5).trim()) as SseEvent;
            seen.push(event);
            if (predicate(event)) {
              return { status: 200, matched: event, seen };
            }
          } catch {
            // A non-JSON data line is not something this plane emits; ignore.
          }
        }
      }
    }

    return { status: 200, matched: null, seen };
  } catch {
    // Abort on budget expiry lands here.
    return { status: 200, matched: null, seen };
  } finally {
    clearTimeout(timer);
  }
}

test.describe('Consultation-loop SSE, cross-tenant posture', () => {
  let doctorToken: string;
  let arcaaiAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    doctorToken = doctor!.token;

    const arcaai = await loginUser(request, ARCAAI_ADMIN_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
    expect(arcaai, 'arcaai_admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    arcaaiAdminToken = arcaai!.token;
  });

  test('sanity — the owning doctor resolves the __GLOBAL__ consultation', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(200);
  });

  test('a cross-tenant caller is refused before the loop stream opens', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/loop/stream`, {
      headers: { Authorization: `Bearer ${arcaaiAdminToken}` },
    });

    // 404 is the contract; 401 is accepted for the same reason the
    // harness-progress spec accepts it (the stream-ticket path rejecting).
    // Either way the stream must NOT open.
    expect([401, 404]).toContain(response.status());
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('a synthetic consultation id is indistinguishable from a cross-tenant one', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${SYNTHETIC_CONSULTATION_ID}/loop/stream`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('the reverse direction is refused too — __GLOBAL__ doctor into an ARCAAI consultation', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${ARCAAI_CONSULTATION_ID}/loop/stream`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect([401, 404]).toContain(response.status());
  });

  test('a cross-tenant caller cannot mint a consultation_loop stream ticket either', async ({ request }) => {
    const response = await request.post('/api/v1/auth/stream-ticket', {
      headers: { Authorization: `Bearer ${arcaaiAdminToken}` },
      data: { scope: `consultation_loop:${GLOBAL_CONSULTATION_ID}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('the sibling SSE streams hold the same pre-stream posture', async ({ request }) => {
    const streams = ['harness-progress/stream', 'assurance/stream', 'trajectory/stream'];

    for (const stream of streams) {
      const response = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/${stream}`, {
        headers: { Authorization: `Bearer ${arcaaiAdminToken}` },
      });
      expect([401, 404], `${stream} must not open for a cross-tenant caller`).toContain(response.status());
    }
  });
});

test.describe('Consultation-loop SSE, delivery', () => {
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
    doctorToken = doctor!.token;
  });

  /**
   * The publisher side is service-token guarded. The test stack runs
   * `SECRETS_PROVIDER=vault`, so `HarnessServiceTokenGuard` resolves the
   * expected value through `SecretsService` from Vault
   * (`<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/HARNESS_SERVICE_TOKEN`) — NOT
   * from the env file.
   *
   * `.env.test`'s value used to be dead config that answered 401, because
   * nothing re-seeded Vault from it on the two-terminal path. fixed
   * that at the source: `scripts/start-test-app.sh` now runs
   * `ensure-test-vault-creds.sh` before launching, exactly as
   * `scripts/test-run.sh` already did for the managed suites, so the value the
   * gateway resolves IS `.env.test`'s value in every supported flow.
   *
   * `E2E_HARNESS_SERVICE_TOKEN` is kept only as an override for a stack started
   * outside those scripts. Skipping when neither resolves stays deliberate: a
   * fabricated pass here would be worse than no coverage.
   */
  const SERVICE_TOKEN = process.env.E2E_HARNESS_SERVICE_TOKEN ?? process.env.HARNESS_SERVICE_TOKEN ?? '';

  test('an event POSTed to the internal loop-event endpoint relays out of the stream', async ({ request }) => {
    test.skip(
      !SERVICE_TOKEN,
      'requires HARNESS_SERVICE_TOKEN in .env.test (start the API with `pnpm test:up:api` so Vault is seeded from it), or an explicit E2E_HARNESS_SERVICE_TOKEN override',
    );
    test.setTimeout(45_000);

    const serviceToken = SERVICE_TOKEN;
    const marker = `task-675-${Date.now().toString(36)}`;

    // Subscribe FIRST — this feed is append-only with no late-join snapshot, so
    // an event published before the subscription exists is genuinely gone.
    const streamed = readSseUntil(
      `${API_ORIGIN}/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/loop/stream`,
      { Authorization: `Bearer ${doctorToken}`, Accept: 'text/event-stream' },
      (event) => event.kind === 'action.started' && (event.data as { marker?: string } | undefined)?.marker === marker,
      30_000,
    );

    // Give the Redis subscription a moment to be established before publishing.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const published = await request.post(`/api/v1/internal/harness/consultations/${GLOBAL_CONSULTATION_ID}/loop-event`, {
      headers: { 'X-Service-Token': serviceToken },
      data: {
        tenantId: '50000000-0000-0000-0000-000000000000',
        kind: 'action.started',
        label: ' live relay probe',
        data: { marker },
      },
    });
    expect(published.status()).toBe(200);
    expect(await published.json()).toEqual({ ok: true });

    const { matched } = await streamed;
    expect(matched, 'the published loop event never arrived on the SSE stream').not.toBeNull();
    expect(matched!.consultationId).toBe(GLOBAL_CONSULTATION_ID);
    expect(matched!.label).toBe('live relay probe');
  });

  test('an idle stream still emits a heartbeat', async ({ request: _request }) => {
    // One heartbeat lands at 15s; budget generously past it.
    test.setTimeout(45_000);

    const { matched } = await readSseUntil(
      `${API_ORIGIN}/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/loop/stream`,
      { Authorization: `Bearer ${doctorToken}`, Accept: 'text/event-stream' },
      (event) => event.type === 'heartbeat',
      HEARTBEAT_MS + 12_000,
    );

    expect(matched, `no heartbeat observed within ${HEARTBEAT_MS + 12_000}ms`).not.toBeNull();
    expect(typeof matched!.ts).toBe('string');
  });
});
