/**
 * Resume-after-drop over a REAL socket.
 *
 * Streams audio, forces a MID-STREAM socket drop (`terminate()` — no close
 * frame, a real network cut), reconnects with a fresh ticket + the resume
 * handshake, and measures what today's plain-XREAD transport actually does.
 *
 * WHY THIS IS A BASELINE, NOT A GREEN ASSERTION
 * --------------------------------------------
 * The gateway's resume buffer (`RESUME_BUFFER_SIZE` transcripts) lives on the
 * per-CONNECTION `SessionInfo`, keyed by the `WebSocket` object. On a socket
 * drop, `handleDisconnect` DELETES that SessionInfo (losing the buffer) AND
 * calls `removeSession(sessionId)` (tearing down the upstream STT session).
 * A reconnect (same sessionId, fresh ticket) therefore gets a BRAND-NEW,
 * EMPTY-buffer SessionInfo: the resume handshake replays nothing (answers
 * `resumed fromSeq:0`, not `lastSeq`), and because the upstream session is gone
 * the caption stream goes SILENT — the "duplicate-then-frozen" C3-01 failure.
 *
 * DISCOVERED WHILE MEASURING: the gateway never even processes the
 * resume/stop/close handshake. It splits WS frames with
 * `Buffer.isBuffer(rawData)`, but ws@8 delivers TEXT frames as Buffer too, so
 * the JSON control channel is misclassified as binary audio and the resume is a
 * no-op. The "recovery" on reconnect is therefore purely the new subscription
 * re-reading the result stream from offset 0 — the DUPLICATE FLOOD (transcript
 * seq resets to 1 and already-seen captions are re-delivered). This is the
 * baseline field `c3_01_duplicate_flood` / `finding_control_frames_ignored`.
 *
 * So this spec:
 *   • RECORDS the observed transport behavior as the reproducible baseline
 *     (attached JSON — the number the eventual fix is measured against),
 *     asserting only the invariant that holds today (the reconnect handshake
 *     is accepted). It does NOT green-wash the defect.
 *   • Asserts the TARGET contract the fix had to satisfy (replay-from-lastSeq,
 *     no duplicate flood, no silent freeze) as a live regression gate.
 *
 * STATUS — the two paragraphs above are HISTORY, not current behavior. Both
 * defects they describe are fixed and the gateway is measured green here:
 *   • control frames are routed on the ws `isBinary` flag, so `{type:'resume'}`
 *     reaches `handleResume` (baseline `finding_control_frames_ignored: false`,
 *     `resumeReplyType: 'resumed'`);
 *   • a transient drop keeps the session alive for `WS_RESUME_GRACE_MS` and the
 *     reconnect rebinds it, so the resume answers `fromSeq: lastSeq + 1` off the
 *     live session instead of a 0-0 re-read (`c3_01_duplicate_flood: false`).
 * The TARGET test below is therefore a live gate, NOT a `test.fixme`. Do not
 * re-add `.fixme` to it — a red here is a regression in the resume path (or the
 * ASR-contention failure the serial mode below exists to prevent), not the
 * historical baseline reasserting itself.
 *
 * ASR CONTENTION — why this describe is `mode: 'serial'`. Both tests drive REAL
 * inference through the single local ASR model, and the caption windows below
 * are latency budgets against it. Measured on an idle stack (2026-09-06): the
 * first caption lands ~15s after a 12s realtime feed ends, a post-resume caption
 * ~4s after an 8s feed. Run the two tests CONCURRENTLY — which `fullyParallel`
 * did until this line — and that latency roughly doubles: the TARGET test's
 * post-resume wait then expires empty and reports a "silent freeze" that is
 * purely two tests queueing behind one model. Reproduced deterministically with
 * just this one file at 2 workers; green with `mode: 'serial'`. Same class of
 * problem `streaming-backpressure-recovery` solves with its own exclusive
 * project — that one is throughput-bound (it must drain a 24s flood), this one
 * is latency-bound and needs only to not race its own sibling.
 *
 * Live-stack requirement: needs STT behind the gateway; self-skips with an
 * explicit reason when unreachable. Prereqs + invocation:
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

/**
 * How long to wait for a caption after a realtime feed ends.
 *
 * This is a budget against REAL ASR latency, not against any gateway behaviour
 * under test. Measured idle (2026-09-06, single local model): ~15s for the first
 * caption of a session, ~4s for a post-resume caption. The previous 15s sat
 * exactly ON the worst idle measurement, so any queueing at all expired it empty
 * and the test reported a "silent freeze" that was really the model being busy.
 * 60s is ~4x that worst case — enough headroom for ordinary jitter, still far
 * short of the test timeout, and still red for an actual freeze (a frozen stream
 * never produces a caption however long you wait).
 */
const CAPTION_WINDOW_MS = 60_000;

// Both tests below drive real inference through the SINGLE local ASR model.
// Serial so they never queue behind each other — see the ASR CONTENTION note in
// the file header for the measurement that made this necessary.
test.describe.configure({ mode: 'serial' });

test.describe('AC-2 — resume-after-drop (C3-01 baseline)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await loginStreamUser(request);
  });

  test('documented baseline: capture the current resume-after-drop transport behavior', async ({ request }, testInfo) => {
    test.setTimeout(180_000);

    const created = await createStreamSession(request, { token });
    test.skip(!created.ok, `streaming session unavailable (is STT running?): ${created.ok ? '' : created.reason}`);
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

        // The gateway registers the SessionInfo + subscribes to
        // results AFTER async auth/lookup, then emits an explicit {type:'ready'}
        // ack. Gate the resume on THAT ack (deterministic) instead of a timing
        // guess, so a resume can never race registration into a NO_SESSION.
        // Fall back to a short settle if the server predates the ready ack.
        const readyAck = await second.waitForMessage((raw) => raw.type === 'ready', 5_000).catch(() => null);
        if (!readyAck) await sleep(600);

        // Resume handshake from the last seq we saw pre-drop.
        second.sendResume(session.sessionId, lastSeq);
        resumeReply = await second.waitForMessage((raw) => raw.type === 'resumed' || raw.type === 'resume_failed', 8_000);
        noSessionErrorOnResume = second.errors.some((e) => e.code === 'NO_SESSION');

        // Anything replayed with seq <= lastSeq is a true resume replay.
        replayedPreDrop = second.transcripts.filter((t) => typeof t.seq === 'number' && t.seq <= lastSeq).length;

        // Feed MORE audio; a silent stream here is the C3-01 freeze.
        await feedFramesRealtime(second, postResumePcm, { frameMs: 80 });
        await second.waitForTranscripts(1, CAPTION_WINDOW_MS);
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
      // C3-01 signatures, recorded here as the baseline to diff against once fixed.
      baseline.c3_01_silent_freeze = postResumeTranscripts.length === 0;
      baseline.c3_01_no_replay = replayedPreDrop === 0;
      baseline.c3_01_duplicate_flood = postResumeTranscripts.some((t) => typeof t.seq === 'number' && (t.seq as number) <= lastSeq) && lastSeq > 0;
      // DISCOVERED DEFECT (surfaced by this gate): the gateway never answers the
      // resume handshake and never re-emits a control reply. The gateway
      // reads WS frames with `Buffer.isBuffer(rawData)` to split audio vs JSON,
      // but ws@8 delivers TEXT frames as Buffer too — so `{type:'resume'|'stop'|
      // 'close'}` text control frames are misclassified as binary audio and the
      // JSON path never runs. Hence the resume handshake is a no-op and the
      // "recovery" seen on reconnect is purely the subscription re-reading the
      // result stream from offset 0 (the duplicate flood).
      baseline.finding_control_frames_ignored =
        !reconnectMessageTypes.includes('resumed') && !reconnectMessageTypes.includes('resume_failed') && !noSessionErrorOnResume;

      await testInfo.attach('resume-after-drop-baseline', {
        body: JSON.stringify(baseline, null, 2),
        contentType: 'application/json',
      });
      // Also to stdout so the `list` reporter surfaces the baseline inline.
      console.log('\n[ AC-2] resume-after-drop baseline:\n' + JSON.stringify(baseline, null, 2));

      // Stable invariant ONLY — whether the gateway answers the resume, replays,
      // duplicates (seq reset), or freezes IS the C3-01 baseline recorded above
      // and the TARGET gate below. We do NOT green-wash any of that here.
      expect(handshakeAccepted, 'reconnect after drop should complete the WS handshake').toBe(true);
    } finally {
      await closeStreamSession(request, token, session.sessionId);
    }
  });

  // ---------------------------------------------------------------------------
  // TARGET CONTRACT (Redis consumer-groups migration + the resume grace window).
  // The migration LANDED, so this is a LIVE regression gate, not a `test.fixme`:
  // it must stay green, and a red here means the resume path regressed. Do not
  // green-wash it by deleting it, loosening an assertion, or re-adding `.fixme`.
  // ---------------------------------------------------------------------------
  test('TARGET: resumes from lastSeq with no duplicate flood and no silent freeze', async ({ request }) => {
    test.setTimeout(210_000);
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
    const banked = await first.waitForTranscripts(1, CAPTION_WINDOW_MS);
    const lastSeq = first.lastSeq();
    // PRECONDITION, asserted rather than assumed. Every assertion below is about
    // resuming FROM a seq the client already saw: `fromSeq === lastSeq + 1` and
    // "nothing with seq <= lastSeq is re-delivered". With no pre-drop caption
    // both collapse to the vacuous lastSeq = 0 case — `fromSeq: 1` and an
    // empty duplicate filter pass while measuring nothing — and the run then
    // dies on the post-resume wait with a "freeze" message that names the wrong
    // cause. This return value used to be discarded, which is exactly how that
    // happened. An ASR that produced nothing at all is a stack problem, not a
    // resume regression, so say so and skip.
    first.drop();
    if (!banked || lastSeq === 0) {
      await closeStreamSession(request, token, session.sessionId);
      test.skip(
        true,
        `no pre-drop caption in ${CAPTION_WINDOW_MS}ms (transcripts=${first.transcripts.length}, lastSeq=${lastSeq}) — ` +
          'the resume-from-lastSeq contract is unmeasurable without one. The ASR produced nothing; check STT/model ' +
          'availability and contention, not the resume path.',
      );
    }
    await sleep(500);

    const refreshed = await refreshStreamTicket(request, token, session.sessionId);
    expect(refreshed.status).toBe(200);
    const second = await openStreamSocket(WsCtor, {
      wsOrigin: session.wsOrigin,
      sessionId: session.sessionId,
      ticket: refreshed.ticket!,
    });
    // Gate the resume on the explicit {type:'ready'} ack so the
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
    const flowed = await second.waitForTranscripts(1, CAPTION_WINDOW_MS);
    expect(flowed, `transcripts must continue flowing after resume (no freeze) — waited ${CAPTION_WINDOW_MS}ms after the post-resume feed`).toBe(
      true,
    );

    second.close();
    await closeStreamSession(request, token, session.sessionId);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
