/**
 * TASK-939 §6.2 — the ACCUMULATION INVARIANT against a real recording.
 *
 * The unit tests prove the mechanism with a scripted model. This proves the BEHAVIOUR with a real
 * clinical conversation, a real ASR stream and the real model the tenant has published — which is
 * the only way to answer the question the owner actually asked: does the note stop tearing itself
 * down while someone is reading it?
 *
 * ## What it measures
 *
 * Every `section.patch` the session publishes, folded through `analyseNoteChurn`
 * (`tests/helpers/note-churn.helper.ts`). The reported number is **churned characters**: text the
 * clinician had already read and then watched change. Zero is the design target; the pre-ticket
 * engine re-emitted the whole document on every turn and so churned on nearly all of them.
 *
 * ## Running it
 *
 * Needs the full local stack (gateway + STT + infra) and an audio file. It SELF-SKIPS when either is
 * missing, so it is inert in CI and on a laptop with nothing running:
 *
 * ```bash
 * pnpm setup:test && pnpm test:up:api            # terminal 1
 * # 16 kHz mono PCM16. Convert any recording with:
 * #   ffmpeg -i <input> -ac 1 -ar 16000 -sample_fmt s16 out.wav
 * TASK939_REPLAY_WAV=/abs/path/out.wav \
 *   npx dotenv -e .env.test -- npx playwright test task-939-note-accumulation-replay
 * ```
 *
 * `TASK939_REPLAY_SECONDS` caps how much audio is fed (default 180 s) — a 13-minute consultation is
 * 13 minutes of wall clock, because the feed is REAL TIME. Feeding faster would not reproduce the
 * defect: the cadence under test is driven by how transcript segments arrive over time, and a burst
 * collapses every turn into one.
 *
 * ## Why it asserts a RANGE and not an exact note
 *
 * The note's wording is the model's, and it changes between runs and between published agent
 * versions. What must hold regardless is the invariant — already-read text is never rewritten unless
 * the turn named a transcript contradiction. The report is attached either way, so a BEFORE/AFTER
 * comparison is possible without re-reading the code.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import WebSocket from 'ws';

import {
  closeStreamSession,
  createStreamSession,
  feedFramesRealtime,
  loadPcm16,
  loginStreamUser,
  openStreamSocket,
  type StreamWsCtor,
} from '../../../../tests/helpers/streaming.helper';
import { analyseNoteChurn, formatChurnReport, type ChurnPatch } from '../../../../tests/helpers/note-churn.helper';

const WsCtor = WebSocket as unknown as StreamWsCtor;

/** The recording to replay. Absolute path; no default file is committed (see §6.2 / OD-7). */
const REPLAY_WAV = process.env.TASK939_REPLAY_WAV?.trim() || '';
const REPLAY_SECONDS = Number(process.env.TASK939_REPLAY_SECONDS ?? '180');

/**
 * Collect `section.patch` events off the consultation's live-summary SSE plane until `stop()` is
 * called. Reads `response.body` directly rather than using `EventSource`, for the same reason
 * `@arcaai/vox-node` does: a header-bearing request is required and `EventSource` cannot set one.
 */
function collectSectionPatches(baseURL: string, token: string, consultationId: string) {
  const patches: ChurnPatch[] = [];
  const controller = new AbortController();

  const done = (async () => {
    try {
      const response = await fetch(`${baseURL}/api/v1/consultations/${consultationId}/live-summary/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; `data:` may repeat within one frame.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (payload) {
            try {
              const parsed = JSON.parse(payload) as ChurnPatch & { event?: string };
              // The channel multiplexes three payload kinds; the discriminator is IN THE JSON.
              if (parsed.event === 'section.patch') patches.push(parsed);
            } catch {
              // A keepalive or a comment frame. Not ours.
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // An aborted read is the normal way this ends.
    }
  })();

  return {
    patches,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

test.describe('TASK-939 — the case note accumulates across a real consultation', () => {
  test('already-published text is never rewritten except on a named contradiction', async ({ request, baseURL }) => {
    test.skip(
      !REPLAY_WAV || !existsSync(REPLAY_WAV),
      'set TASK939_REPLAY_WAV to a 16 kHz mono PCM16 WAV (ffmpeg -i <in> -ac 1 -ar 16000 -sample_fmt s16 out.wav)',
    );
    // Real-time feed plus the realtime TEXT budget on the final flush.
    test.setTimeout((REPLAY_SECONDS + 180) * 1000);

    const token = await loginStreamUser(request);
    test.skip(!token, 'could not authenticate against the gateway — is it running (pnpm test:up:api)?');

    const opened = await request.post('/api/v1/consultations/open', {
      headers: { Authorization: `Bearer ${token}` },
      data: { patientId: `task939-${Date.now()}`, language: 'en' },
    });
    test.skip(opened.status() !== 201, `consultations/open unavailable: ${opened.status()}`);
    const consultationId = (await opened.json()).id as string;

    const created = await createStreamSession(request, { token, consultationId });
    test.skip(!created.ok, `streaming session unavailable (is STT running?): ${created.ok ? '' : created.reason}`);
    if (!created.ok) return;

    const started = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { sessionId: created.session.sessionId },
    });
    expect(started.status(), await started.text()).toBe(200);

    // Subscribe BEFORE feeding: `section.patch` has no late-join replay, so a patch published
    // before the subscription exists is simply not observed — and an unobserved patch would make
    // the churn report silently optimistic.
    const collector = collectSectionPatches(baseURL!, token, consultationId);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const socket = await openStreamSocket(WsCtor, created.session);
    const pcm = loadPcm16(REPLAY_WAV, { maxSeconds: REPLAY_SECONDS });
    await feedFramesRealtime(socket, pcm, { realtime: true });
    socket.close();

    // `recording/stop` runs the lane's FINAL flush before answering.
    const stopped = await request.post(`/api/v1/consultations/${consultationId}/recording/stop`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(stopped.status(), await stopped.text()).toBe(200);

    await collector.stop();
    await closeStreamSession(request, token, created.session.sessionId);

    const report = analyseNoteChurn(collector.patches);
    // Attached whichever way the assertions go: this number, not the prose, is what a later run is
    // compared against. PHI-free by construction — sizes, counts and addresses only.
    await test.info().attach('task-939-note-churn.json', {
      body: JSON.stringify({ consultationId, replaySeconds: REPLAY_SECONDS, ...report }, null, 2),
      contentType: 'application/json',
    });

    // A session that published nothing proves nothing. Fail loudly rather than report zero churn
    // over zero patches — the defect's own signature is a busy feed, so silence is a broken setup
    // (or a broken lane), never a pass.
    expect(report.patchCount, 'no section.patch was published — the incremental plane did not run').toBeGreaterThan(0);

    // THE INVARIANT.
    expect(
      report.violations.filter((violation) => !violation.declaredReplace),
      'a patch claimed to APPEND and then rewrote earlier text — the worst form of the defect',
    ).toEqual([]);
    expect(report.churnedChars, `the note rewrote text the clinician had already read — ${formatChurnReport(report)}`).toBe(0);
  });
});
