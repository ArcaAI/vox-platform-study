/**
 * Ticket-refresh mid-session over a REAL socket.
 *
 * Exercises the documented re-auth path for a live streaming session: each
 * stream ticket is one-shot (consumed by the gateway on first WS open), so a
 * reconnect MUST mint a fresh ticket via
 * `POST /audio/transcription-jobs/stream/session/:sessionId/refresh-ticket`.
 * This is the ONE clearly-passing path of the three — the
 * re-auth mechanism exists and works today; the suite pins it so the
 * consumer-groups transport migration cannot regress it.
 *
 * Contract verified:
 *   1. A mid-session `refresh-ticket` returns a NEW single-use ticket (200,
 *      distinct value, future expiry) that AUTHENTICATES a reconnect WS.
 *   2. The ORIGINAL ticket is one-shot: a second open with it is closed with
 *      the generic `4401` (consumed) — no enumeration signal.
 *   3. `refresh-ticket` for an unbound/foreign session 404s (the
 *      `@TenantOwnedResource` guard — 404-over-403, no existence leak).
 *
 * Live-stack requirement: session create forwards to STT, so the
 * live-session tests self-skip with an explicit reason when it is unreachable
 * (Playwright global setup treats STT as optional). 
 * for prereqs + invocation (`RESET_DB=false E2E_WAIT_SERVICES=true`).
 */
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import {
  closeStreamSession,
  createStreamSession,
  loginStreamUser,
  openStreamSocket,
  probeStreamHandshake,
  refreshStreamTicket,
  streamWsUrl,
  wsOriginFromApiUrl,
  type StreamSessionInfo,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';

// The `ws` default export satisfies the structural `StreamWsCtor` the helper
// wants; the cast documents the module-resolution boundary (see the helper).
const WsCtor = WebSocket as unknown as StreamWsCtor;

const WS_AUTH_FAILED_CODE = 4401;
const SYNTHETIC_SESSION_ID = '018f0000-0000-7455-8000-000000000004';

test.describe('AC-4 — ticket-refresh mid-session', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await loginStreamUser(request);
  });

  // No live session needed — pins the fail-closed refresh contract.
  test('refresh-ticket for an unbound session → 404 (no existence leak)', async ({ request }) => {
    const refreshed = await refreshStreamTicket(request, token, SYNTHETIC_SESSION_ID);
    expect(refreshed.status).toBe(404);
    expect(refreshed.ticket).toBeUndefined();
  });

  test.describe('with a live streaming session', () => {
    let session: StreamSessionInfo | undefined;
    let skipReason = '';

    test.beforeAll(async ({ request }) => {
      const created = await createStreamSession(request, { token });
      if (created.ok) session = created.session;
      else skipReason = created.reason;
    });

    test.afterAll(async ({ request }) => {
      if (session) await closeStreamSession(request, token, session.sessionId);
    });

    test('mints a fresh single-use ticket that authenticates a reconnect', async ({ request }) => {
      test.skip(!session, `streaming session unavailable (is STT running?): ${skipReason}`);
      const s = session!;

      // Open with the original ticket, confirm the socket is live.
      const socket = await openStreamSocket(WsCtor, {
        wsFullUrl: s.wsFullUrl,
        sessionId: s.sessionId,
        ticket: s.ticket,
      });
      expect(socket.raw.readyState).toBe(WsCtor.OPEN);

      // Mid-session: mint a fresh ticket. It must be new + future-dated.
      const refreshed = await refreshStreamTicket(request, token, s.sessionId);
      expect(refreshed.status).toBe(200);
      expect(refreshed.ticket).toBeTruthy();
      expect(refreshed.ticket).not.toBe(s.ticket);
      expect(refreshed.ticketExpiresAt ?? 0).toBeGreaterThan(Date.now());

      // Drop the first socket and reconnect with the REFRESHED ticket.
      socket.drop();
      const reconnectUrl = streamWsUrl(wsOriginFromApiUrl(), s.sessionId, refreshed.ticket!);
      const handshake = await probeStreamHandshake(WsCtor, reconnectUrl);
      expect(handshake.outcome, `refreshed-ticket reconnect should be accepted, got ${JSON.stringify(handshake)}`).toBe('accepted');
    });

    test('the original one-shot ticket is rejected on a second open (generic 4401)', async ({ request }) => {
      test.skip(!session, `streaming session unavailable (is STT running?): ${skipReason}`);

      // A dedicated session so the assertion is independent of the test above.
      const created = await createStreamSession(request, { token });
      test.skip(!created.ok, `second session unavailable: ${created.ok ? '' : created.reason}`);
      const s = (created as { ok: true; session: StreamSessionInfo }).session;

      try {
        // First open consumes the ticket (accepted).
        const first = await probeStreamHandshake(WsCtor, s.wsFullUrl);
        expect(first.outcome).toBe('accepted');

        // Reusing the SAME (now-consumed) ticket must be closed 4401.
        const second = await probeStreamHandshake(WsCtor, s.wsFullUrl);
        expect(second.outcome).toBe('closed');
        expect(second.code).toBe(WS_AUTH_FAILED_CODE);
      } finally {
        await closeStreamSession(request, token, s.sessionId);
      }
    });
  });
});
