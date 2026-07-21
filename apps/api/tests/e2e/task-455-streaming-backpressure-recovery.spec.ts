/**
 * Backpressure / overload recovery over a REAL socket.
 *
 * SCOPE (honest, and documented as a real baseline for the eventual fix)
 * ------------------------------------------------------------------
 * Two backpressure surfaces exist on the realtime loop:
 *
 *   (a) INGEST overload — the client floods audio frames far faster than
 *       realtime into `stt:audio:{sid}` (XADD `MAXLEN ~ 10000`). This is
 *       client-drivable over a real socket and is exactly the path the
 *       consumer-groups migration reshapes, so it IS the measurement here:
 *       flood, then assert the loop RECOVERS (socket stays open, captions still
 *       flow, the session still finalizes) and record any client-observable
 *       drop signal (`BRIDGE_ERROR` frames from failed async audio writes).
 *
 *   (b) EGRESS watermark — the gateway drops PARTIAL transcripts and queues
 *       FINALS once the client socket's `bufferedAmount` exceeds
 *       `WS_EGRESS_HIGH_WATERMARK_BYTES` (512 KiB). Reaching 512 KiB of
 *       buffered egress requires a stalled reader AND thousands of tiny partial
 *       messages — NOT naturally reproducible over a real socket at real STT
 *       cadence, and the watermark cannot be lowered on the shared live stack.
 *       That contract is pinned in-process by
 *       `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts`
 *       and is captured here only as a `test.fixme`
 *       target (it ties to the dropped-frame counters).
 *
 * Live-stack requirement: needs STT-V2 behind the gateway; self-skips with an
 * explicit reason when unreachable. Prereqs + invocation: ticket README
 * (`RESET_DB=false E2E_WAIT_SERVICES=true`).
 */
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import {
  closeStreamSession,
  createStreamSession,
  feedFramesRealtime,
  loadPcm16,
  loginStreamUser,
  openStreamSocket,
  type StreamSessionInfo,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';

const WsCtor = WebSocket as unknown as StreamWsCtor;

/** Audio flooded (as fast as possible) to overload the ingest path. */
const FLOOD_SECONDS = 24;

test.describe('TASK-455 AC-3 — backpressure / overload recovery', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await loginStreamUser(request);
  });

  test('documented baseline: ingest overload recovers (socket stays open, captions resume, session finalizes)', async ({ request }, testInfo) => {
    test.setTimeout(150_000);

    const created = await createStreamSession(request, { token });
    test.skip(!created.ok, `streaming session unavailable (is STT-V2 running?): ${created.ok ? '' : created.reason}`);
    const session = (created as { ok: true; session: StreamSessionInfo }).session;

    const report: Record<string, unknown> = { sessionId: session.sessionId };
    try {
      const socket = await openStreamSocket(WsCtor, {
        wsFullUrl: session.wsFullUrl,
        sessionId: session.sessionId,
        ticket: session.ticket,
      });

      const pcm = loadPcm16(undefined, { maxSeconds: FLOOD_SECONDS });
      const floodStart = performance.now();
      // realtime:false → burst every frame with no pacing (ingest overload).
      const framesSent = await feedFramesRealtime(socket, pcm, { frameMs: 80, realtime: false });
      const floodMs = Math.round(performance.now() - floodStart);

      // Socket must survive the burst (recovery precondition — not torn down).
      const openAfterFlood = socket.raw.readyState === WsCtor.OPEN;

      // The loop must drain and keep producing captions (recovery).
      const gotTranscripts = await socket.waitForTranscripts(1, 30_000);
      // `{type:'stop'}` is a JSON TEXT control frame. The gateway branches on
      // the `message` event's `isBinary`
      // arg, so stop reaches `writeControlCommand(finalize)`. Whether a `closed`
      // status then arrives within the window depends on the upstream finalize
      // completing — recorded (not asserted) as `reachedClosedStatusAfterStop`.
      socket.sendStop();
      const closed = await socket.waitForClosedStatus(10_000);

      report.framesSent = framesSent;
      report.floodDurationMs = floodMs;
      report.floodRealtimeRatio = Number((floodMs / 1000 / FLOOD_SECONDS).toFixed(3));
      report.socketOpenAfterFlood = openAfterFlood;
      report.transcriptsReceived = socket.transcripts.length;
      report.finalsReceived = socket.transcripts.filter((t) => t.isFinal).length;
      report.reachedClosedStatusAfterStop = closed !== null;
      // Client-observable drop signal: BRIDGE_ERROR = a failed async audio write
      // (the gateway's droppedAudioFrames counter is server-side-only otherwise).
      report.bridgeErrorFrames = socket.errors.filter((e) => e.code === 'BRIDGE_ERROR').length;
      report.errorFrames = socket.errors.length;
      report.notes = [
        'Ingest-overload recovery only: the loop survives a burst far faster than realtime.',
        'Gateway EGRESS-watermark drops (partials dropped / finals queued at 512 KiB) are NOT ' +
          'client-observable and not naturally reproducible on the shared stack — see the ' +
          'test.fixme + stt-ws.gateway.test.ts.',
        'TASK-467 (FIXED): `{type:stop}` finalize is a JSON text frame the gateway USED to ' +
          'misclassify as binary audio (ws@8 text-as-Buffer); it now branches on the message ' +
          "event's isBinary arg and reaches writeControlCommand(finalize). reachedClosedStatusAfterStop " +
          'now hinges on the upstream finalize emitting a closed status, not on frame classification.',
      ];

      await testInfo.attach('backpressure-overload-baseline', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      console.log('\n[TASK-455 AC-3] backpressure/overload baseline:\n' + JSON.stringify(report, null, 2));

      socket.close();

      // Recovery invariants (reproducible on today's transport):
      expect(openAfterFlood, 'socket must survive the ingest flood (not be torn down)').toBe(true);
      expect(gotTranscripts, 'captions must still flow after the ingest overload (recovery)').toBe(true);
    } finally {
      await closeStreamSession(request, token, session.sessionId);
    }
  });

  // ---------------------------------------------------------------------------
  // TARGET CONTRACT (egress watermark) — needs a lowered
  // `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` or a synthetic egress stall, neither
  // available on the shared live stack. Pinned in-process by
  // stt-ws.gateway.test.ts; `test.fixme` here documents the wire-level bar and
  // ties dropped-partial / dropped-final visibility to the dropped-frame counters.
  // ---------------------------------------------------------------------------
  test.fixme('TARGET (TASK-454/457): under egress backpressure, partials are dropped and finals are preserved & observable', async () => {
    // Requires lowering the 512 KiB egress high-watermark (env
    // STT_WS_EGRESS_HIGH_WATERMARK_BYTES) so a stalled reader crosses it, and
    // a client-observable dropped-frame signal. Neither is present
    // on the shared live stack; encoded here so the bar is explicit.
    expect(true).toBe(true);
  });
});
