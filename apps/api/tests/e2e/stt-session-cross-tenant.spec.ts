/**
 * Cross-tenant live-transcript (stt_session) egress probes.
 *
 * Without the ownership guard, `POST /auth/stream-ticket` would mint `stt_session:<sessionId>`
 * tickets with NO ownership check (the scope would silently bypass the
 * consultation-only regex), and the WS gateway would validate only the ticket's
 * SCOPE STRING — so any authenticated user in tenant B who learned a
 * tenant-A sessionId could subscribe to tenant A's live transcript (PHI).
 *
 * The gateway-side sessionId → tenantId binding
 * (`StreamSessionTenantBindingService`, already enforced on
 * `DELETE /stream/session/:sessionId`) is wired into BOTH paths, defense-in-depth:
 *
 *   1. Mint: `stt_session:<sessionId>` may only be minted when the session
 *      binding matches the caller's active tenant — missing binding OR
 *      mismatch both 404 (fail-closed, no existence leak, DEF-C3).
 *   2. WS handshake: the gateway compares the ticket's tenant to the bound
 *      owning tenant and closes 4401 with the generic reason on missing or
 *      mismatched bindings.
 *
 * Because gate 1 now refuses to mint a cross-tenant ticket at all, a
 * black-box probe can no longer reach gate 2 with a foreign-tenant ticket —
 * that layer is pinned by the unit suite
 * (`src/modules/streaming/__tests__/stt-ws.gateway.test.ts`).
 * This spec covers the wire-visible contract:
 *
 *   - fail-closed mint for an unbound (synthetic) sessionId → 404
 *     (this is the direct regression pin: pre-fix it returned 200);
 *   - genuine cross-tenant mint probe against a REAL tenant-__GLOBAL__
 *     session from a tenant-ARCAAI token → 404 with no tenant leak;
 *   - the same-tenant owner can still mint (200) and complete the WS
 *     handshake with the minted ticket;
 *   - a never-minted ticket is rejected at the WS handshake with the
 *     generic 4401 close (no tenant material on the wire).
 *
 * SAME-TENANT HIJACK. The gates above compared the TENANT only, so a
 * colleague — same tenant, different user — sailed through every one of them:
 * mint a ticket for a live consultation, connect, and the audio-ingest +
 * transcript stream is transplanted onto the attacker's socket. The binding
 * now records the owning USER too. The `doctor` / `doctor2` seeded pair (both
 * in tenant __GLOBAL__) is that exact probe, run against the four enforcement
 * points that are visible over HTTP: mint, refresh-ticket, close, and switch.
 * The WS handshake leg is unreachable black-box once the mint refuses, and is
 * pinned in `src/modules/streaming/__tests__/stt-ws.gateway.test.ts`.
 *
 * Live-stack requirement: the mint fail-closed probes need only the API +
 * Redis. The live-session group additionally needs STT running (session
 * create forwards to it) — those tests skip with an explicit reason when the
 * streaming service is unavailable, mirroring the conventions.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded production ASR pipeline id from
 * `packages/database/src/prisma/db_main/seed/06-stt.ts`
 * (`DEFAULT_ASR_PIPELINES[0]` — `production-whisper-large-v3`).
 * Visible to every customer tenant via the SYSTEM-tenant inheritance.
 */
const PRODUCTION_PIPELINE_ID = '81000000-0000-0000-0001-000000000001';

/**
 * uuidv7-shaped sessionId that no tenant has ever seen — no binding exists,
 * so the mint must 404 fail-closed (pre-fix this minted a ticket).
 */
const SYNTHETIC_SESSION_ID = '018f0000-0000-7450-8000-000000000000';

/** Generic WS close contract (single enumeration-proof tuple). */
const WS_AUTH_FAILED_CODE = 4401;
const WS_GENERIC_AUTH_REASON = 'Authentication failed';

/** ws:// origin derived from the HTTP base URL (WS path sits OUTSIDE /api/v1). */
const WS_ORIGIN = (process.env.API_URL || 'http://localhost:8968/api/v1').replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');

interface WsHandshakeResult {
  outcome: 'accepted' | 'closed';
  code?: number;
  reason?: string;
}

/**
 * Open a WS handshake against the STT gateway and report whether the server
 * kept it open or closed it. The gateway upgrades FIRST and only then runs
 * the ticket gate, so a rejection surfaces as an immediate post-open close —
 * we wait a short grace window before declaring the handshake accepted.
 */
function wsHandshake(sessionId: string, ticket: string, timeoutMs = 8000): Promise<WsHandshakeResult> {
  return new Promise((resolve, reject) => {
    const url = `${WS_ORIGIN}/ws/stt/stream?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    let settled = false;
    const settle = (result: WsHandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.terminate();
        reject(new Error(`WS handshake to ${url} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on('open', () => {
      // Grace window for the server-side auth gate to close the socket.
      setTimeout(() => {
        if (!settled && socket.readyState === WebSocket.OPEN) {
          settle({ outcome: 'accepted' });
          socket.close(1000);
        }
      }, 750);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      settle({ outcome: 'closed', code, reason: reason.toString() });
    });
    socket.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function mintTicket(
  request: APIRequestContext,
  token: string,
  scope: string,
): Promise<{ status: number; body: { ticket?: string; message?: string } }> {
  const response = await request.post('/api/v1/auth/stream-ticket', {
    headers: { Authorization: `Bearer ${token}` },
    data: { scope },
  });
  return { status: response.status(), body: await response.json() };
}

test.describe('C4-01 — stt_session stream-ticket tenant binding', () => {
  let doctorToken: string;
  /** A COLLEAGUE of `doctor`: same tenant (__GLOBAL__), different user. */
  let colleagueToken: string;
  let arcaaiSuperAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doctorLogin!.token;

    const colleagueLogin = await loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY);
    expect(colleagueLogin, 'doctor2 login (__GLOBAL__) failed').toBeTruthy();
    colleagueToken = colleagueLogin!.token;

    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiLogin!.token;
  });

  // -------------------------------------------------------------------
  // Gate 1, fail-closed — needs no live streaming session (API + Redis
  // only). Pre-fix this minted a ticket (200); post-fix it must 404.
  // -------------------------------------------------------------------
  test('mint stt_session:<unbound sessionId> → 404 fail-closed (pre-fix: 200)', async ({ request }) => {
    const { status, body } = await mintTicket(request, doctorToken, `stt_session:${SYNTHETIC_SESSION_ID}`);
    expect(status).toBe(404);
    expect(body.ticket).toBeUndefined();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('mint stt_session with an EMPTY sessionId → 404 fail-closed', async ({ request }) => {
    const { status, body } = await mintTicket(request, doctorToken, 'stt_session:');
    expect(status).toBe(404);
    expect(body.ticket).toBeUndefined();
  });

  test('consultation_job scope minting is unchanged by the stt_session gate (200)', async ({ request }) => {
    const { status, body } = await mintTicket(request, doctorToken, 'consultation_job:task-450-sanity-job');
    expect(status).toBe(200);
    expect(body.ticket).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // Genuine cross-tenant probe against a REAL session — requires STT
  // behind the gateway (session create forwards to it). Skips with an
  // explicit reason when the streaming service is unavailable.
  // -------------------------------------------------------------------
  test.describe('with a live tenant-__GLOBAL__ streaming session', () => {
    let sessionId: string | undefined;
    let sessionCreateFailure = '';

    test.beforeAll(async ({ request }) => {
      const createResp = await request.post('/api/v1/audio/transcription-jobs/stream/session', {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: { pipelineId: PRODUCTION_PIPELINE_ID },
      });
      if (createResp.status() === 201) {
        const created = (await createResp.json()) as { sessionId: string };
        sessionId = created.sessionId;
      } else {
        sessionCreateFailure = `POST stream/session → ${createResp.status()}: ${(await createResp.text()).slice(0, 200)}`;
      }
    });

    test.afterAll(async ({ request }) => {
      if (!sessionId) return;
      // Best-effort cleanup — the binding TTL reclaims it regardless.
      await request
        .delete(`/api/v1/audio/transcription-jobs/stream/session/${sessionId}`, {
          headers: { Authorization: `Bearer ${doctorToken}` },
        })
        .catch(() => undefined);
    });

    test('cross-tenant mint (tenant ARCAAI → __GLOBAL__ session) → 404, no ticket, no tenant leak', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const { status, body } = await mintTicket(request, arcaaiSuperAdminToken, `stt_session:${sessionId}`);
      expect(status).toBe(404);
      expect(body.ticket).toBeUndefined();
      expect(String(body.message ?? '')).not.toMatch(/tenant/i);
    });

    test('same-tenant owner mint → 200, and the WS handshake with that ticket is accepted', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const { status, body } = await mintTicket(request, doctorToken, `stt_session:${sessionId}`);
      expect(status).toBe(200);
      expect(body.ticket).toBeTruthy();

      const handshake = await wsHandshake(sessionId!, body.ticket!);
      expect(handshake.outcome).toBe('accepted');
    });

    test('WS handshake with a never-minted ticket → generic 4401 close, no tenant material on the wire', async () => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const handshake = await wsHandshake(sessionId!, 'task-450-never-minted-ticket');
      expect(handshake.outcome).toBe('closed');
      expect(handshake.code).toBe(WS_AUTH_FAILED_CODE);
      expect(handshake.reason).toBe(WS_GENERIC_AUTH_REASON);
      expect(String(handshake.reason)).not.toMatch(/tenant/i);
    });

    // -----------------------------------------------------------------
    // SAME TENANT, DIFFERENT USER — the hijack. `doctor2` is a colleague of
    // `doctor` inside __GLOBAL__, so every one of these probes passed the
    // tenant-only gate and returned 200/204 before the owner was recorded.
    // Each must now be indistinguishable from a session that does not exist.
    // -----------------------------------------------------------------
    test('COLLEAGUE mint (same tenant, different user) → 404, no ticket (pre-fix: 200)', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const { status, body } = await mintTicket(request, colleagueToken, `stt_session:${sessionId}`);
      expect(status).toBe(404);
      expect(body.ticket).toBeUndefined();
      // 404-over-403: the refusal must not disclose that the session exists
      // or who owns it.
      expect(String(body.message ?? '')).not.toMatch(/tenant|owner|user/i);
    });

    test('COLLEAGUE refresh-ticket → 404, no ticket (pre-fix: 200)', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const response = await request.post(`/api/v1/audio/transcription-jobs/stream/session/${sessionId}/refresh-ticket`, {
        headers: { Authorization: `Bearer ${colleagueToken}` },
      });
      expect(response.status()).toBe(404);
      expect((await response.text()).toLowerCase()).not.toContain('ticket');
    });

    test('COLLEAGUE switch-to-fallback → 404 (pre-fix: reached the switch)', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const response = await request.post(`/api/v1/audio/transcription-jobs/stream/session/${sessionId}/switch-to-fallback`, {
        headers: { Authorization: `Bearer ${colleagueToken}` },
      });
      expect(response.status()).toBe(404);
    });

    test('COLLEAGUE close → 404, and the OWNER can still mint afterwards (the session survived)', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const response = await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${sessionId}`, {
        headers: { Authorization: `Bearer ${colleagueToken}` },
      });
      expect(response.status()).toBe(404);

      // Silent DoS regression: the refused close must not have torn the
      // session down underneath its owner.
      const { status } = await mintTicket(request, doctorToken, `stt_session:${sessionId}`);
      expect(status).toBe(200);
    });

    test('after the cross-tenant probes, the owner can still mint for the session (no collateral damage)', async ({ request }) => {
      test.skip(!sessionId, `streaming session unavailable (is STT running?): ${sessionCreateFailure}`);
      const { status } = await mintTicket(request, doctorToken, `stt_session:${sessionId}`);
      expect(status).toBe(200);
    });
  });
});
