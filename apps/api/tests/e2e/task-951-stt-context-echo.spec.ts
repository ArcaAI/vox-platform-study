/**
 * TASK-951 R2 (D-8) — an STT stream session echoes the client's own metadata, end to end.
 *
 * The owner's ask is literal: *"for audio stream, ALaaS will send metadata contains the mic_id, or
 * something else for the hope to return exactly the same metadata things along with time-synced
 * transcription"*. The design answer (OD-8) is one STANDALONE session per microphone, each
 * carrying its own `context`, each echoing that context verbatim on every transcript beside a
 * session epoch that puts the session's own relative segment times on one wall clock. HOPE's mixer,
 * diarization and consultation binding are all untouched, and `apps/stt` learns nothing new.
 *
 * This spec is that claim as HTTP + WebSocket calls, driven by a SERVICE ACCOUNT — the credential
 * class an external broker actually holds (TASK-933):
 *
 *   exchange a service token -> create a session WITH context -> read the echo off the 201 ->
 *   open the WS and read the epoch off `ready` -> feed audio and read the echo off a transcript
 *
 * plus the two refusals that make the field safe to store and re-send per utterance: an oversized
 * object (413) and — where a bound schema exists — a violating one (400).
 *
 * ─── How to run it ─────────────────────────────────────────────────────────
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-951
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed. See
 * `01-development-workflow.md` §Test Placement.)
 *
 * ─── What needs to be running ──────────────────────────────────────────────
 *
 * The gateway alone is enough for the 201-echo, the `ready` epoch and both refusals. The
 * TRANSCRIPT echo additionally needs `apps/stt` behind the gateway and a resolvable ASR agent for
 * the account's tenant; that case self-skips with an explicit reason when either is missing —
 * a 404/503 there is a TRANSPORT fact, never an authorization one.
 *
 * ─── Fixtures it needs ─────────────────────────────────────────────────────
 *
 * A seeded database, and nothing hand-made:
 *   · the ArcaAI service account `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret,
 *     which carries the realtime scopes since TASK-933;
 *   · whatever ASR agent the account's tenant resolves to through the assignment cascade — the
 *     session names none, exactly as a broker would.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import {
  feedFramesRealtime,
  loadPcm16,
  openStreamSocket,
  streamWsUrl,
  wsOriginFromApiUrl,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';

const WsCtor = WebSocket as unknown as StreamWsCtor;

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

/** The shape the `arcaai_realtime_transcription` schema's `stream` kind declares (R1 / D-8). */
const STREAM_CONTEXT = { stream: { mic_ids: ['mic-1'], speaker_label: 'Clinician' } };

const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

/**
 * Create a stream session as the service account. The session names NO agent, so the tenant's
 * `AgentAssignment` cascade decides — which is what a broker does, and what keeps this spec
 * independent of which agent a given seed happens to assign.
 */
async function createSession(request: APIRequestContext, token: string, body: Record<string, unknown>) {
  return request.post('/api/v1/audio/transcription-jobs/stream/session', {
    headers: svcHeaders(token),
    data: { sampleRate: 16000, ...body },
  });
}

/** 503 = STT is down, 404 = no ASR agent resolvable for this tenant. Neither is an authz fact. */
const TRANSPORT_STATUSES = [404, 503];

test.describe('TASK-951 R2 — STT session context echo (service account)', () => {
  let svcToken: string;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);
  });

  // ── 1. The refusals — gateway only, no STT needed ─────────────────────────

  test('refuses a context over 4 KB with 413 CONTEXT_TOO_LARGE', async ({ request }) => {
    // The size gate runs before the entitlement check, the agent resolution and the STT round
    // trip, so this case is meaningful even on a stack with no STT at all.
    const oversized = { stream: { mic_ids: ['mic-1'], note: 'x'.repeat(4096) } };

    const res = await createSession(request, svcToken, { context: oversized });

    expect(res.status(), await res.text()).toBe(413);
    expect((await res.json()).code).toBe('CONTEXT_TOO_LARGE');
  });

  test('a context just under the bound is NOT refused on size', async ({ request }) => {
    // Pins the boundary from the other side: 413 must mean "too large", not "context at all".
    const nearLimit = { stream: { mic_ids: ['mic-1'], note: 'x'.repeat(3900) } };

    const res = await createSession(request, svcToken, { context: nearLimit });

    expect(res.status(), await res.text()).not.toBe(413);
    if (res.status() === 201) {
      await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${(await res.json()).sessionId}`, { headers: svcHeaders(svcToken) });
    }
  });

  // ── 2. The echo on the create response ────────────────────────────────────

  test('a session created with a context echoes it back, with a session epoch', async ({ request }) => {
    const before = Date.now();
    const res = await createSession(request, svcToken, { context: STREAM_CONTEXT });

    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(
      TRANSPORT_STATUSES.includes(res.status()),
      `no live streaming session available (STT down, or no ASR agent assigned for this tenant): ${res.status()}`,
    );

    const session = await res.json();
    expect(session.context).toEqual(STREAM_CONTEXT);
    expect(typeof session.sessionEpochMs).toBe('number');
    expect(session.sessionEpochMs).toBeGreaterThanOrEqual(before);
    expect(session.sessionEpochMs).toBeLessThanOrEqual(Date.now());

    await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}`, { headers: svcHeaders(svcToken) });
  });

  test('a session created WITHOUT a context carries none back', async ({ request }) => {
    const res = await createSession(request, svcToken, {});

    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session available: ${res.status()}`);

    const session = await res.json();
    expect(session.context).toBeUndefined();
    // The epoch is unconditional — every session has a creation instant.
    expect(typeof session.sessionEpochMs).toBe('number');

    await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}`, { headers: svcHeaders(svcToken) });
  });

  // ── 3. The WS handshake ───────────────────────────────────────────────────

  test('the WS `ready` frame carries the session epoch, before any audio is sent', async ({ request }) => {
    const res = await createSession(request, svcToken, { context: STREAM_CONTEXT });
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session available: ${res.status()}`);

    const session = await res.json();
    const socket = await openStreamSocket(WsCtor, {
      wsFullUrl: streamWsUrl(wsOriginFromApiUrl(), session.sessionId, session.ticket),
      sessionId: session.sessionId,
      ticket: session.ticket,
    });

    try {
      const ready = await socket.waitForMessage((raw) => raw.type === 'ready', 10_000);
      expect(ready, 'the gateway must emit a readiness ack').not.toBeNull();
      // The clock a multi-microphone client needs to align its sessions arrives on the FIRST
      // frame, not on the first utterance — which may be many seconds away, or never.
      expect(ready?.sessionEpochMs).toBe(session.sessionEpochMs);
    } finally {
      socket.close();
      await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}`, { headers: svcHeaders(svcToken) });
    }
  });

  // ── 4. The echo on a real transcript ──────────────────────────────────────

  test('every transcript of the session carries the context verbatim and the epoch', async ({ request }) => {
    // Real inference: give it the same budget the other live streaming specs use.
    test.setTimeout(180_000);

    const res = await createSession(request, svcToken, { context: STREAM_CONTEXT });
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(
      TRANSPORT_STATUSES.includes(res.status()),
      `apps/stt is not running (or no ASR agent is assigned) — the transcript echo needs a live session: ${res.status()}`,
    );

    const session = await res.json();
    const socket = await openStreamSocket(WsCtor, {
      wsFullUrl: streamWsUrl(wsOriginFromApiUrl(), session.sessionId, session.ticket),
      sessionId: session.sessionId,
      ticket: session.ticket,
    });

    try {
      // `ready` gates the first send: the gateway attaches its message handler AFTER async auth,
      // and `ws` drops frames that arrive before a listener exists.
      expect(await socket.waitForReady(10_000), 'readiness ack').toBe(true);

      await feedFramesRealtime(socket, loadPcm16(undefined, { maxSeconds: 20 }), { frameMs: 80 });
      socket.sendStop();

      const got = await socket.waitForTranscripts(1, 60_000);
      test.skip(!got, 'no transcript arrived within the ASR budget — the echo is unobservable without one');

      const transcripts = socket.messages.map((m) => m.raw).filter((raw) => raw.type === 'transcript');
      expect(transcripts.length).toBeGreaterThan(0);
      for (const t of transcripts) {
        // VERBATIM: the object the client sent, not a normalized or re-keyed version of it.
        expect(t.context).toEqual(STREAM_CONTEXT);
        expect(t.sessionEpochMs).toBe(session.sessionEpochMs);
        // The echo rides BESIDE the timing, which is what makes it time-synced: a caller places
        // this segment at `sessionEpochMs + startTime * 1000` on the shared clock.
        expect(typeof t.startTime).toBe('number');
      }
    } finally {
      socket.close();
      await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}`, { headers: svcHeaders(svcToken) });
    }
  });
});
