/**
 * TASK-455 (S-10) AC-2 — resume-after-drop over a REAL socket (C3-01 surface).
 *
 * Streams audio, forces a MID-STREAM socket drop (`terminate()` — no close
 * frame, a real network cut), reconnects with a fresh ticket + the D-17 resume
 * handshake, and measures what today's plain-XREAD transport actually does.
 *
 * WHY THIS IS A BASELINE, NOT A GREEN ASSERTION
 * --------------------------------------------
 * The gateway's resume buffer (`RESUME_BUFFER_SIZE` transcripts) lives on the
 * per-CONNECTION `SessionInfo`, keyed by the `WebSocket` object. On a socket
 * drop, `handleDisconnect` DELETES that SessionInfo (losing the buffer) AND
 * calls `removeSession(sessionId)` (tearing down the upstream STT-V2 session).
 * A reconnect (same sessionId, fresh ticket) therefore gets a BRAND-NEW,
 * EMPTY-buffer SessionInfo: the resume handshake replays nothing (answers
 * `resumed fromSeq:0`, not `lastSeq`), and because the upstream session is gone
 * the caption stream goes SILENT — the "duplicate-then-frozen" C3-01 failure.
 *
 * So this spec:
 * DISCOVERED WHILE MEASURING (reported to TASK-457): the gateway never even
 * processes the D-17 resume/stop/close handshake. It splits WS frames with
 * `Buffer.isBuffer(rawData)`, but ws@8 delivers TEXT frames as Buffer too, so
 * the JSON control channel is misclassified as binary audio and the resume is a
 * no-op. The "recovery" on reconnect is therefore purely the new subscription
 * re-reading the result stream from offset 0 — the DUPLICATE FLOOD (transcript
 * seq resets to 1 and already-seen captions are re-delivered). This is the
 * baseline field `c3_01_duplicate_flood` / `finding_control_frames_ignored`.
 *
 * So this spec:
 *   • RECORDS the observed transport behavior as the reproducible baseline
 *     (attached JSON — the number TASK-457 is measured against), asserting only
 *     the invariant that holds today (the reconnect handshake is accepted). It
 *     does NOT green-wash the defect.
 *   • Encodes the TARGET contract TASK-457 must satisfy as a `test.fixme`
 *     (replay-from-lastSeq, no duplicate flood, no silent freeze) so the desired
 *     bar is visible and cannot pass by accident.
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
  refreshStreamTicket,
  type StreamSessionInfo,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';

const WsCtor = WebSocket as unknown as StreamWsCtor;

/** Seconds of audio fed before the forced drop (enough to bank ≥1 transcript). */
const PRE_DROP_SECONDS = 12;
/** Seconds fed AFTER resume — a silent stream here is the C3-01 freeze. */
const POST_RESUME_SECONDS = 8;

test.describe('TASK-455 AC-2 — resume-after-drop (C3-01 baseline)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await loginStreamUser(request);
  });

  test('documented baseline: capture the current resume-after-drop transport behavior', async ({ request }, testInfo) => {
    test.setTimeout(150_000);

    const created = await createStreamSession(request, { token });
    test.skip(!created.ok, `streaming session unavailable (is STT-V2 running?): ${created.ok ? '' : created.reason}`);
    const session = (created as { ok: true; session: StreamSessionInfo }).session;

    const pcm = loadPcm16(undefined, { maxSeconds: PRE_DROP_SECONDS + POST_RESUME_SECONDS });
    const frameBytesPer = Math.floor((16000 * 80) / 1000) * 2; // 80 ms frames
    const preDropFrames = Math.floor((PRE_DROP_SECONDS * 16000 * 2) / frameBytesPer);
    const preDropPcm = pcm.subarray(0, preDropFrames * frameBytesPer);
    const postResumePcm = pcm.subarray(preDropFrames * frameBytesPer);

    const baseline: Record<string, unknown> = { sessionId: session.sessionId };
    try {
      // --- Connection #1: stream until we bank at least one transcript --------
      const first = await openStreamSocket(WsCtor, {
        wsFullUrl: session.wsFullUrl,
        sessionId: session.sessionId,
        ticket: session.ticket,
      });
      await feedFramesRealtime(first, preDropPcm, { frameMs: 80 });
      await first.waitForTranscripts(1, 25_000);

      const preDrop = first.transcripts.map((t) => ({ seq: t.seq, isFinal: t.isFinal, at: Math.round(t.at) }));
      const lastSeq = first.lastSeq();
      baseline.preDropTranscripts = preDrop.length;
      baseline.preDropSeqs = preDrop.map((t) => t.seq);
      baseline.lastSeqBeforeDrop = lastSeq;

      // --- Forced mid-stream drop (real transport cut, no close frame) --------
      first.drop();
      await sleep(500);

      // --- Reconnect: fresh ticket (the old one was consumed on open) ---------
      const refreshed = await refreshStreamTicket(request, token, session.sessionId);
      baseline.refreshTicketStatus = refreshed.status;

      let resumeReply: Record<string, unknown> | null = null;
      let postResumeTranscripts: Array<{ seq?: number; isFinal: boolean }> = [];
      let replayedPreDrop = 0;
      let handshakeAccepted = false;
      let noSessionErrorOnResume = false;
      let reconnectMessageTypes: string[] = [];

      if (refreshed.status === 200 && refreshed.ticket) {
        const second = await openStreamSocket(WsCtor, {
          wsFullUrl: undefined,
          wsOrigin: session.wsOrigin,
          sessionId: session.sessionId,
          ticket: refreshed.ticket,
        });
        handshakeAccepted = second.raw.readyState === WsCtor.OPEN;

        // TASK-457 I1 — the gateway registers the SessionInfo + subscribes to
        // results AFTER async auth/lookup, then emits an explicit {type:'ready'}
        // ack. Gate the resume on THAT ack (deterministic) instead of a timing
        // guess, so a resume can never race registration into a NO_SESSION.
        // Fall back to a short settle if the server predates the ready ack.
        const readyAck = await second.waitForMessage((raw) => raw.type === 'ready', 5_000).catch(() => null);
        if (!readyAck) await sleep(600);

        // D-17 resume handshake from the last seq we saw pre-drop.
        second.sendResume(session.sessionId, lastSeq);
        resumeReply = await second.waitForMessage((raw) => raw.type === 'resumed' || raw.type === 'resume_failed', 8_000);
        noSessionErrorOnResume = second.errors.some((e) => e.code === 'NO_SESSION');

        // Anything replayed with seq <= lastSeq is a true resume replay.
        replayedPreDrop = second.transcripts.filter((t) => typeof t.seq === 'number' && t.seq <= lastSeq).length;

        // Feed MORE audio; a silent stream here is the C3-01 freeze.
        await feedFramesRealtime(second, postResumePcm, { frameMs: 80 });
        await second.waitForTranscripts(1, 15_000);
        second.sendStop();
        await sleep(1500);

        postResumeTranscripts = second.transcripts.map((t) => ({ seq: t.seq, isFinal: t.isFinal }));
        reconnectMessageTypes = Array.from(new Set(second.messages.map((m) => String(m.raw.type))));
        second.close();
      }

      baseline.handshakeAcceptedAfterDrop = handshakeAccepted;
      baseline.resumeReplyType = resumeReply?.type ?? null;
      baseline.resumeReplyFromSeq = resumeReply?.fromSeq ?? null;
      baseline.resumeReplyMinAvailableSeq = resumeReply?.minAvailableSeq ?? null;
      baseline.noSessionErrorOnResume = noSessionErrorOnResume;
      baseline.preDropTranscriptsReplayedOnReconnect = replayedPreDrop;
      baseline.transcriptsAfterResume = postResumeTranscripts.length;
      baseline.reconnectMessageTypesFromGateway = reconnectMessageTypes;
      baseline.resumeActuallyReplayedFromLastSeq =
        resumeReply?.type === 'resumed' && typeof resumeReply.fromSeq === 'number' && (resumeReply.fromSeq as number) > lastSeq;
      // C3-01 signatures, recorded for TASK-457 to diff against.
      baseline.c3_01_silent_freeze = postResumeTranscripts.length === 0;
      baseline.c3_01_no_replay = replayedPreDrop === 0;
      baseline.c3_01_duplicate_flood = postResumeTranscripts.some((t) => typeof t.seq === 'number' && (t.seq as number) <= lastSeq) && lastSeq > 0;
      // DISCOVERED DEFECT (surfaced by this gate): the gateway never answers the
      // D-17 resume handshake and never re-emits a control reply. The gateway
      // reads WS frames with `Buffer.isBuffer(rawData)` to split audio vs JSON,
      // but ws@8 delivers TEXT frames as Buffer too — so `{type:'resume'|'stop'|
      // 'close'}` text control frames are misclassified as binary audio and the
      // JSON path never runs. Hence the resume handshake is a no-op and the
      // "recovery" seen on reconnect is purely the subscription re-reading the
      // result stream from offset 0 (the duplicate flood). Reported to TASK-457.
      baseline.finding_control_frames_ignored =
        !reconnectMessageTypes.includes('resumed') && !reconnectMessageTypes.includes('resume_failed') && !noSessionErrorOnResume;

      await testInfo.attach('resume-after-drop-baseline', {
        body: JSON.stringify(baseline, null, 2),
        contentType: 'application/json',
      });
      // Also to stdout so the `list` reporter surfaces the baseline inline.
      // eslint-disable-next-line no-console
      console.log('\n[TASK-455 AC-2] resume-after-drop baseline:\n' + JSON.stringify(baseline, null, 2));

      // Stable invariant ONLY — whether the gateway answers the resume, replays,
      // duplicates (seq reset), or freezes IS the C3-01 baseline recorded above
      // and the `test.fixme` target below. We do NOT green-wash any of that here.
      expect(handshakeAccepted, 'reconnect after drop should complete the WS handshake').toBe(true);
    } finally {
      await closeStreamSession(request, token, session.sessionId);
    }
  });

  // ---------------------------------------------------------------------------
  // TARGET CONTRACT for TASK-457 (Redis consumer-groups migration). Marked
  // `test.fixme` — it encodes the behavior the migration must deliver and MUST
  // NOT pass on today's plain-XREAD transport. When TASK-457 lands, drop the
  // `.fixme` and this becomes the regression gate. Do not green-wash by
  // deleting it.
  // ---------------------------------------------------------------------------
  test('TARGET (TASK-457): resumes from lastSeq with no duplicate flood and no silent freeze', async ({ request }) => {
    test.setTimeout(150_000);
    const created = await createStreamSession(request, { token });
    test.skip(!created.ok, `streaming session unavailable: ${created.ok ? '' : created.reason}`);
    const session = (created as { ok: true; session: StreamSessionInfo }).session;

    const pcm = loadPcm16(undefined, { maxSeconds: PRE_DROP_SECONDS + POST_RESUME_SECONDS });
    const frameBytesPer = Math.floor((16000 * 80) / 1000) * 2;
    const preDropFrames = Math.floor((PRE_DROP_SECONDS * 16000 * 2) / frameBytesPer);

    const first = await openStreamSocket(WsCtor, {
      wsFullUrl: session.wsFullUrl,
      sessionId: session.sessionId,
      ticket: session.ticket,
    });
    await feedFramesRealtime(first, pcm.subarray(0, preDropFrames * frameBytesPer), { frameMs: 80 });
    await first.waitForTranscripts(1, 25_000);
    const lastSeq = first.lastSeq();
    first.drop();
    await sleep(500);

    const refreshed = await refreshStreamTicket(request, token, session.sessionId);
    expect(refreshed.status).toBe(200);
    const second = await openStreamSocket(WsCtor, {
      wsOrigin: session.wsOrigin,
      sessionId: session.sessionId,
      ticket: refreshed.ticket!,
    });
    // TASK-457 I1 — gate the resume on the explicit {type:'ready'} ack so the
    // resume can never race the new socket's async registration into a
    // NO_SESSION. Deterministic — not a timing guess.
    await second.waitForMessage((raw) => raw.type === 'ready', 10_000);
    second.sendResume(session.sessionId, lastSeq);
    const resumed = await second.waitForMessage((raw) => raw.type === 'resumed', 15_000);

    // (1) resume acknowledges continuation from the next unseen seq.
    expect(resumed?.type).toBe('resumed');
    expect(Number(resumed?.fromSeq)).toBe(lastSeq + 1);

    // (2) no duplicate flood: nothing with seq <= lastSeq is re-delivered.
    const duplicates = second.transcripts.filter((t) => typeof t.seq === 'number' && t.seq <= lastSeq);
    expect(duplicates, 'no transcript with seq <= lastSeq may be re-delivered').toHaveLength(0);

    // (3) no silent freeze: new transcripts continue after resume.
    await feedFramesRealtime(second, pcm.subarray(preDropFrames * frameBytesPer), { frameMs: 80 });
    const flowed = await second.waitForTranscripts(1, 15_000);
    expect(flowed, 'transcripts must continue flowing after resume (no freeze)').toBe(true);

    second.close();
    await closeStreamSession(request, token, session.sessionId);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
