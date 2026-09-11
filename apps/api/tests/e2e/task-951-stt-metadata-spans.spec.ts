/**
 * TASK-951 R2 (clarified 2026-09-11) — per-span stream metadata, end to end.
 *
 * The owner's clarification is what this spec exists for, and it is a stronger claim than the
 * session-level echo its sibling (`task-951-stt-context-echo.spec.ts`) pins:
 *
 * > *"the ALaaS can send 1 or 2 or more than 2 mic ids when recordings, that's the purpose of
 * > requirement: hope platform must return exactly the metadata contains mic ids time-synced
 * > with the generated transcript."*
 *
 * "Time-synced" is the load-bearing word. The set of live microphones CHANGES DURING a
 * recording, so a value fixed at session creation cannot answer it — whatever it held would be
 * stamped on segments whose audio was captured under a different set. What HOPE returns instead
 * is, per transcript, the SPANS of that segment's own audio and the metadata in force over each:
 *
 *   create a session -> open the WS -> setMetadata(one mic) -> feed audio ->
 *   setMetadata(two mics) -> feed audio -> every transcript carries spans clipped to ITS window
 *
 * plus the refusals that make the frame safe to accept on a live socket at all — and the
 * property that matters more than either: a refused frame does NOT end the session.
 *
 * ─── How to run it ─────────────────────────────────────────────────────────
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-951-stt-metadata
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed. See
 * `01-development-workflow.md` §Test Placement.)
 *
 * ─── What needs to be running ──────────────────────────────────────────────
 *
 * The gateway alone gets a session created and a socket open, which is enough for the refusals.
 * The SPAN assertions additionally need `apps/stt` behind the gateway and a resolvable ASR agent
 * for the account's tenant: without a real transcript there is no window to clip to. Those cases
 * self-skip with an explicit reason — a 404/503 there is a TRANSPORT fact, never an
 * authorization one.
 *
 * ─── Fixtures it needs ─────────────────────────────────────────────────────
 *
 * A seeded database, and nothing hand-made: the ArcaAI service account
 * `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret (realtime scopes since
 * TASK-933), and whatever ASR agent its tenant resolves to through the assignment cascade — the
 * session names none, exactly as a broker would.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import {
  feedFramesRealtime,
  loadPcm16,
  openStreamSocket,
  streamWsUrl,
  wsOriginFromApiUrl,
  type StreamSocket,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';

const WsCtor = WebSocket as unknown as StreamWsCtor;

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

/** One microphone live at a time — the owner's contract. `mic_id` is the seeded kind's one required key. */
const MIC_1 = { mic_id: 'mic-1' };
const MIC_2 = { mic_id: 'mic-2' };

/** 503 = STT is down, 404 = no ASR agent resolvable for this tenant. Neither is an authz fact. */
const TRANSPORT_STATUSES = [404, 503];

const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

/** Create a stream session as the service account, naming NO agent — the cascade decides. */
async function createSession(request: APIRequestContext, token: string, body: Record<string, unknown> = {}) {
  return request.post('/api/v1/audio/transcription-jobs/stream/session', {
    headers: svcHeaders(token),
    data: { sampleRate: 16000, ...body },
  });
}

/**
 * The control frame, sent on the raw socket.
 *
 * `StreamSocket` is a shared helper owned by the whole e2e suite and deliberately carries only
 * the verbs every streaming spec needs; this one frame is this ticket's, so it goes on the wire
 * here rather than growing that surface for one caller.
 */
const setMetadata = (socket: StreamSocket, metadata: Record<string, unknown>): void => {
  socket.raw.send(JSON.stringify({ type: 'metadata', metadata }));
};

type Span = { from: number; to: number; value: Record<string, unknown> };

/**
 * Open the session's socket and wait for the readiness ack.
 *
 * `ready` GATES the first send: the gateway attaches its message handler after the async auth
 * gates, and `ws` drops frames that arrive before a listener exists — so a `metadata` frame sent
 * the instant the socket opens can vanish with no error anywhere.
 */
async function openReady(session: { sessionId: string; ticket: string }) {
  const socket = await openStreamSocket(WsCtor, {
    wsFullUrl: streamWsUrl(wsOriginFromApiUrl(), session.sessionId, session.ticket),
    sessionId: session.sessionId,
    ticket: session.ticket,
  });
  expect(await socket.waitForReady(10_000), 'readiness ack').toBe(true);
  return socket;
}

async function closeSession(request: APIRequestContext, token: string, sessionId: string): Promise<void> {
  await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${sessionId}`, { headers: svcHeaders(token) });
}

test.describe('TASK-951 R2 — time-synced stream metadata (service account)', () => {
  let svcToken: string;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);
  });

  // ── 1. The refusals — a live socket, no transcript needed ─────────────────

  test('refuses an oversized metadata frame WITHOUT ending the session', async ({ request }) => {
    // The property that matters more than the refusal itself: a malformed label must never cost
    // a clinician the rest of a consultation. The session stays up and keeps accepting audio.
    const res = await createSession(request, svcToken);
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session available: ${res.status()}`);

    const session = await res.json();
    const socket = await openReady(session);

    try {
      setMetadata(socket, { mic_id: 'mic-1', note: 'x'.repeat(2048) });

      const error = await socket.waitForMessage((raw) => raw.type === 'error', 10_000);
      expect(error?.code).toBe('METADATA_TOO_LARGE');

      // Still alive: a subsequent frame is still accepted, and the socket was never closed.
      setMetadata(socket, MIC_1);
      const stillUp = await socket.waitForMessage((raw) => raw.type === 'error' && raw.code !== 'METADATA_TOO_LARGE', 2_000);
      expect(stillUp, 'a valid frame after a refused one must not be answered with an error').toBeNull();
      expect(socket.closeInfo, 'the session must survive a refused metadata frame').toBeUndefined();
    } finally {
      socket.close();
      await closeSession(request, svcToken, session.sessionId);
    }
  });

  test('accepts a metadata frame silently — a declaration is not an event', async ({ request }) => {
    // Pins the boundary from the other side: the error channel must mean "something was wrong",
    // not "metadata was sent".
    const res = await createSession(request, svcToken);
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session available: ${res.status()}`);

    const session = await res.json();
    const socket = await openReady(session);

    try {
      setMetadata(socket, MIC_2);

      expect(await socket.waitForMessage((raw) => raw.type === 'error', 2_000)).toBeNull();
      expect(socket.closeInfo).toBeUndefined();
    } finally {
      socket.close();
      await closeSession(request, svcToken, session.sessionId);
    }
  });

  test('the ArcaAI agent binds the `stream` kind: a frame without `mic_id` is refused WITH the problem, one carrying it is accepted', async ({
    request,
  }) => {
    // The seeded CONTENT, not only the transport. `realtime-transcription` freezes
    // `arcaai_realtime_transcription`, whose `stream` kind is marked `streamContext` and requires
    // `mic_id` — ONE microphone at a time, the owner's contract. Naming the agent pins this test to
    // that schema instead of to whatever the cascade resolves for the service account's tenant; an
    // agent binding no stream kind would accept both frames and prove nothing about the gate.
    const res = await createSession(request, svcToken, { agentSlug: 'realtime-transcription' });
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session on the ArcaAI agent: ${res.status()}`);

    const session = await res.json();
    expect(session.agentSlug).toBe('realtime-transcription');
    const socket = await openReady(session);

    try {
      // A set of ids, or a camelCase spelling, are the two ways an integrator gets this wrong;
      // both are missing the one required property.
      setMetadata(socket, { mic_ids: ['mic-1'], micId: 'mic-1' });
      const refused = await socket.waitForMessage((raw) => raw.type === 'error', 10_000);
      expect(refused?.code).toBe('METADATA_SCHEMA_VIOLATION');
      // The refusal names the shape it wanted — a client cannot fix a schema it is not shown.
      expect(refused?.problems).toContain('/mic_id: required property is missing');
      expect(socket.closeInfo, 'a refused frame must not end the session').toBeUndefined();

      // The seeded shape is accepted silently: no NEW error frame follows it.
      const errorsBefore = socket.messages.filter((m) => m.raw.type === 'error').length;
      setMetadata(socket, MIC_2);
      await socket.waitForMessage(() => false, 1_500);
      expect(socket.messages.filter((m) => m.raw.type === 'error').length, 'a `mic_id` frame was refused').toBe(errorsBefore);
      expect(socket.closeInfo).toBeUndefined();
    } finally {
      socket.close();
      await closeSession(request, svcToken, session.sessionId);
    }
  });

  // ── 2. The spans on a real transcript ─────────────────────────────────────

  test('every transcript carries the metadata in force over ITS OWN audio window', async ({ request }) => {
    // Real inference: the same budget the other live streaming specs use.
    test.setTimeout(180_000);

    const res = await createSession(request, svcToken);
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(
      TRANSPORT_STATUSES.includes(res.status()),
      `apps/stt is not running (or no ASR agent is assigned) — spans are unobservable without a transcript: ${res.status()}`,
    );

    const session = await res.json();
    const socket = await openReady(session);

    try {
      const pcm = loadPcm16(undefined, { maxSeconds: 20 });
      const half = Math.floor(pcm.length / 2 / 2) * 2; // whole PCM16 samples

      // Microphone 1, then microphone 2, with audio either side. The declaration carries NO timestamp:
      // the gateway places each one at its own count of the audio received so far, which is the
      // same quantity `apps/stt` derives `startTime`/`endTime` from.
      setMetadata(socket, MIC_1);
      await feedFramesRealtime(socket, pcm.subarray(0, half), { frameMs: 80 });
      setMetadata(socket, MIC_2);
      await feedFramesRealtime(socket, pcm.subarray(half), { frameMs: 80 });
      socket.sendStop();

      const got = await socket.waitForTranscripts(1, 60_000);
      test.skip(!got, 'no transcript arrived within the ASR budget — the spans are unobservable without one');

      const transcripts = socket.messages.map((m) => m.raw).filter((raw) => raw.type === 'transcript');
      expect(transcripts.length).toBeGreaterThan(0);

      const seenMics: string[] = [];
      for (const t of transcripts) {
        const metadata = t.metadata as Record<string, unknown> | undefined;
        const spans = t.metadataSpans as Span[] | undefined;
        const startTime = t.startTime as number;
        const endTime = t.endTime as number;

        // Every segment of a session that declared metadata is labelled — it is only ever absent
        // where no declaration was in force, and the first one here preceded all the audio.
        // `metadata` is FLAT and VERBATIM: `metadata.mic_id` reads exactly as it did on the v1
        // wire, one of the two objects sent, never a normalized or re-keyed version.
        expect(metadata, `a transcript at ${startTime}–${endTime} carried no metadata`).toBeDefined();
        expect([MIC_1, MIC_2]).toContainEqual(metadata);
        seenMics.push(String(metadata!.mic_id));

        // The bounds ride beside it, CLIPPED TO THIS SEGMENT: a consumer reads them against
        // `startTime`/`endTime` and is never handed a bound outside them — that is what
        // "time-synced" buys. Contiguous and in time order; the flat object is one of them.
        expect(spans, `a transcript at ${startTime}–${endTime} carried no metadataSpans`).toBeDefined();
        expect(spans!.length).toBeGreaterThan(0);
        for (const span of spans!) {
          expect(span.from).toBeGreaterThanOrEqual(startTime);
          expect(span.to).toBeLessThanOrEqual(endTime);
          expect(span.to).toBeGreaterThanOrEqual(span.from);
          expect([MIC_1, MIC_2]).toContainEqual(span.value);
        }
        for (let i = 1; i < spans!.length; i++) {
          expect(spans![i]!.from).toBe(spans![i - 1]!.to);
        }
        expect(spans!.map((span) => span.value)).toContainEqual(metadata);
      }

      // Both microphones reached the transcripts. If only the first ever did, the platform is
      // stamping a session-level value and the mid-recording switch was lost — which is exactly
      // the failure this ticket fixes, and it would pass every assertion above.
      expect(new Set(seenMics).size, `only one mic_id was ever reported: ${seenMics[0]}`).toBeGreaterThan(1);
    } finally {
      socket.close();
      await closeSession(request, svcToken, session.sessionId);
    }
  });

  test('a session that never sends metadata carries none — the wire is unchanged', async ({ request }) => {
    // The compatibility half. Every client that has been parsing this wire must see exactly
    // what it saw before this ticket: the field ABSENT, never an empty array.
    test.setTimeout(180_000);

    const res = await createSession(request, svcToken);
    expect([201, ...TRANSPORT_STATUSES], await res.text()).toContain(res.status());
    test.skip(TRANSPORT_STATUSES.includes(res.status()), `no live streaming session available: ${res.status()}`);

    const session = await res.json();
    const socket = await openReady(session);

    try {
      await feedFramesRealtime(socket, loadPcm16(undefined, { maxSeconds: 20 }), { frameMs: 80 });
      socket.sendStop();

      const got = await socket.waitForTranscripts(1, 60_000);
      test.skip(!got, 'no transcript arrived within the ASR budget');

      for (const t of socket.messages.map((m) => m.raw).filter((raw) => raw.type === 'transcript')) {
        expect(t.metadata).toBeUndefined();
        expect(t.metadataSpans).toBeUndefined();
      }
    } finally {
      socket.close();
      await closeSession(request, svcToken, session.sessionId);
    }
  });
});
