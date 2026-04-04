import { expect, test, type Page, type WebSocket as PwWebSocket } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFinalTranscriptLatency,
  computeFirstPartialLatency,
  computeRtf,
  type TimestampedFinal,
  type TimestampedPartial,
} from './helpers/latency-metrics.js';
import {
  computeHallucinationRate,
  computeSer,
  computeTaskSuccess,
  type TranscriptFinal,
} from './helpers/segment-metrics.js';
import { concatenateSegmentTexts, parseGroundTruth } from './helpers/transcript-parser.js';
import { computeCer, computeWer, formatWerReport } from './helpers/wer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WER_THRESHOLD = 0.20;
const AUDIO_DURATION_SECONDS = 38; // wait time: audio_1.wav is ~35.3s (5s silence lead-in + 27.3s speech + 3s silence)
const SPEECH_END_SECONDS = 32.3; // ground truth speech boundary for hallucination detection (27.3 + 5s offset)
const DRAIN_IDLE_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 500;
const DRAIN_MAX_WAIT_MS = 30_000;

const GROUND_TRUTH_PATH = path.resolve(__dirname, 'fixtures', 'audio_1.txt');

/** Pipeline name as seeded in the DB (see packages/database seed 06-stt.ts) */
const E2E_PIPELINE_NAME = 'E2E Test';

// ---------------------------------------------------------------------------
// Types matching WS transcript messages from stt-v2
// ---------------------------------------------------------------------------

interface WsWordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface WsTranscriptMessage {
  type: 'transcript';
  text: string;
  isFinal: boolean;
  startTime: number;
  endTime: number;
  speakerId?: string;
  speakerLabel?: string;
  wordTimestamps?: WsWordTimestamp[];
  [key: string]: unknown;
}

interface WsStatusMessage {
  type: 'status';
  status: string;
  message: string;
}

type WsMessage = WsTranscriptMessage | WsStatusMessage | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Auth injection helper
// ---------------------------------------------------------------------------

async function injectAuth(page: Page): Promise<void> {
  const apiKey = process.env.PLAYGROUND_API_KEY;
  const tenantId = process.env.PLAYGROUND_TENANT_ID;

  if (!apiKey || !tenantId) {
    throw new Error(
      'Missing PLAYGROUND_API_KEY or PLAYGROUND_TENANT_ID environment variables. ' +
        'Set them before running E2E tests.',
    );
  }

  await page.addInitScript(
    ({ key, tenant }) => {
      const authState = {
        state: {
          authMethod: 'apiKey' as const,
          apiKey: key,
          tenantId: tenant,
          tenantKey: '',
          tenantName: '',
          accessToken: '',
          refreshToken: '',
          user: null,
          isAuthenticated: true,
          impersonatedUser: null,
          impersonationToken: '',
          isImpersonating: false,
          originalTenantId: '',
        },
        version: 0,
      };
      localStorage.setItem('arcavox.auth', JSON.stringify(authState));
    },
    { key: apiKey, tenant: tenantId },
  );
}

// ---------------------------------------------------------------------------
// WebSocket capture helper
// ---------------------------------------------------------------------------

interface WsCapture {
  transcripts: Array<WsTranscriptMessage & { receivedAt: number }>;
  statuses: Array<WsStatusMessage & { receivedAt: number }>;
  all: Array<WsMessage & { receivedAt: number }>;
  streamStartedAt: number | null;
}

function setupWsCapture(page: Page): WsCapture {
  const capture: WsCapture = { transcripts: [], statuses: [], all: [], streamStartedAt: null };

  page.on('websocket', (ws: PwWebSocket) => {
    if (!ws.url().includes('/ws/stt')) return;

    // Record stream start when the STT WebSocket opens (server never sends a
    // "streaming" status message -- the frontend sets that state locally).
    if (capture.streamStartedAt === null) {
      capture.streamStartedAt = Date.now();
    }

    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return;
      try {
        const receivedAt = Date.now();
        const msg = JSON.parse(frame.payload) as WsMessage;
        const stamped = { ...msg, receivedAt };
        capture.all.push(stamped);
        if (msg.type === 'transcript') {
          capture.transcripts.push(stamped as WsTranscriptMessage & { receivedAt: number });
        } else if (msg.type === 'status') {
          capture.statuses.push(stamped as WsStatusMessage & { receivedAt: number });
        }
      } catch {
        // Binary or non-JSON frame, ignore
      }
    });
  });

  return capture;
}

// ---------------------------------------------------------------------------
// Drain helper: wait for all finals to arrive after audio playback
// ---------------------------------------------------------------------------

async function drainTranscripts(capture: WsCapture): Promise<void> {
  const startDrain = Date.now();
  let lastFinalCount = capture.transcripts.filter((t) => t.isFinal).length;
  let lastChangeTime = Date.now();

  while (Date.now() - startDrain < DRAIN_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
    const currentFinalCount = capture.transcripts.filter((t) => t.isFinal).length;

    if (currentFinalCount > lastFinalCount) {
      lastFinalCount = currentFinalCount;
      lastChangeTime = Date.now();
    }

    if (Date.now() - lastChangeTime >= DRAIN_IDLE_TIMEOUT_MS) {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Audio track capture: intercept getUserMedia to mute after playback
// ---------------------------------------------------------------------------

/**
 * Monkey-patch getUserMedia so we can disable audio tracks later.
 * Chrome's --use-file-for-fake-audio-capture loops the WAV file infinitely;
 * disabling the tracks after the original audio plays sends silence to the
 * STT pipeline, preventing duplicate transcripts from the looped audio.
 */
async function setupAudioTrackCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).__e2eMediaStreams = [] as MediaStream[];
    navigator.mediaDevices.getUserMedia = async function (
      constraints?: MediaStreamConstraints,
    ) {
      const stream = await orig(constraints);
      (window as any).__e2eMediaStreams.push(stream);
      return stream;
    };
  });
}

async function muteAudioTracks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const streams: MediaStream[] = (window as any).__e2eMediaStreams || [];
    for (const stream of streams) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('realtime transcription accuracy meets WER threshold', async ({ page }) => {
  // Load ground truth
  const groundTruth = readFileSync(GROUND_TRUTH_PATH, 'utf-8');
  const expectedSegments = parseGroundTruth(groundTruth, {
    expectTimestamps: true,
    expectSpeakers: false,
  });
  const referenceText = concatenateSegmentTexts(expectedSegments);

  // 1. Inject auth, set up WS capture, and intercept getUserMedia
  await injectAuth(page);
  await setupAudioTrackCapture(page);
  const capture = setupWsCapture(page);

  // 2. Navigate to live transcription page
  await page.goto('/audio/live-transcription', { waitUntil: 'networkidle' });
  await page.waitForURL('**/audio/live-transcription', { timeout: 15_000 });

  // 3. Select a microphone source
  const micSelect = page.locator('[data-doc="mic-sources"]').getByRole('combobox');
  await expect(micSelect).toBeVisible({ timeout: 10_000 });
  await micSelect.click();
  await page.getByRole('option').first().click();

  // 4. Wait for pipeline dropdown to load
  const pipelineCard = page.locator('[data-doc="audio-pipeline"]');
  const pipelineSelect = pipelineCard.getByRole('combobox');
  await expect(pipelineSelect).toBeVisible({ timeout: 15_000 });
  await expect(pipelineSelect).not.toHaveText('Select a pipeline...', { timeout: 15_000 });

  // 5. Select the E2E basic pipeline
  await pipelineSelect.click();
  const pipelineOption = page.getByRole('option', { name: E2E_PIPELINE_NAME });
  if (await pipelineOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pipelineOption.click();
  } else {
    await page.keyboard.press('Escape');
    console.warn(`E2E pipeline "${E2E_PIPELINE_NAME}" not found, using default`);
  }

  // 6. Start streaming
  const startButton = page.getByRole('button', { name: 'Connect & Stream' });
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();
  await expect(page.getByText('streaming', { exact: true })).toBeVisible({ timeout: 30_000 });

  // 7. Verify streaming stays active
  await page.waitForTimeout(3_000);
  const hasServerError = await page.locator('text=Internal server error').isVisible();
  expect(
    hasServerError,
    'Backend returned "Internal server error". Check STT service logs and ensure the pipeline exists.',
  ).toBe(false);
  await expect(
    page.getByText('streaming', { exact: true }),
    'Streaming status lost -- backend may have errored or disconnected.',
  ).toBeVisible();

  // 8. Wait for audio playback, then mute tracks to prevent Chrome loop
  await page.waitForTimeout(AUDIO_DURATION_SECONDS * 1000);
  await muteAudioTracks(page);

  // 9. Drain: wait for backend to flush remaining finals (silence triggers VAD end-of-speech)
  await drainTranscripts(capture);

  // 10. Stop streaming
  const disconnectButton = page.getByRole('button', { name: 'Disconnect' });
  if (await disconnectButton.isVisible()) {
    await disconnectButton.click();
    await expect(page.getByText('idle')).toBeVisible({ timeout: 15_000 });
  }

  // 11. Collect final transcripts
  const finalTranscripts = capture.transcripts.filter((t) => t.isFinal);
  const hypothesisText = finalTranscripts.map((t) => t.text).join(' ');

  // Verify no looped audio leaked through
  const maxStartTime = Math.max(...finalTranscripts.map((t) => t.startTime), 0);
  expect(
    maxStartTime,
    `Looped audio detected: transcript at ${maxStartTime.toFixed(1)}s exceeds audio duration. ` +
    `Audio track muting may not have prevented Chrome's fake audio loop.`,
  ).toBeLessThan(AUDIO_DURATION_SECONDS);

  // 12. DOM transcript for cross-validation
  const domTexts = await page.locator('.group p').allInnerTexts();
  const domTranscriptText = domTexts.join(' ').trim();

  // --- Always attach WebSocket data (before assertions so they survive failures) ---
  await test.info().attach('ws-messages-all.json', {
    body: JSON.stringify(capture.all, null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('ws-transcripts-final.json', {
    body: JSON.stringify(finalTranscripts, null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('ws-statuses.json', {
    body: JSON.stringify(capture.statuses, null, 2),
    contentType: 'application/json',
  });

  // --- A. WS message format validation ---
  expect(
    finalTranscripts.length,
    `No final transcripts received.\n` +
      `  Total WS messages: ${capture.all.length}\n` +
      `  Transcript messages (incl. partials): ${capture.transcripts.length}\n` +
      `  Status messages: ${capture.statuses.map((s) => `${s.status}: ${s.message}`).join('; ') || 'none'}\n` +
      `  DOM text: ${domTranscriptText.slice(0, 200) || '(empty)'}`,
  ).toBeGreaterThan(0);

  for (const msg of finalTranscripts) {
    expect(msg.type).toBe('transcript');
    expect(typeof msg.text).toBe('string');
    expect(msg.isFinal).toBe(true);
    expect(msg.endTime).toBeGreaterThanOrEqual(msg.startTime);
  }

  // --- B. Compute all metrics (before assertions so report always prints) ---
  const werResult = computeWer(referenceText, hypothesisText);
  const report = formatWerReport(werResult, 'basic', WER_THRESHOLD, referenceText, hypothesisText);

  // B1. Character Error Rate (CER)
  const cerResult = computeCer(referenceText, hypothesisText);

  // B2. Sentence Error Rate (SER) -- uses time-overlap segment matching
  const transcriptFinals: TranscriptFinal[] = finalTranscripts.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
  }));
  const serResult = computeSer(expectedSegments, transcriptFinals);

  // B3. Task Success Rate
  const taskSuccess = computeTaskSuccess(expectedSegments, transcriptFinals);

  // B4. Silence Hallucination Rate (uses ALL finals, not filtered)
  const allFinals = capture.transcripts.filter((t) => t.isFinal);
  const allTranscriptFinals: TranscriptFinal[] = allFinals.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
  }));
  const hallucination = computeHallucinationRate(allTranscriptFinals, SPEECH_END_SECONDS);

  // B5. Final Transcript Latency (P50/P95/P99)
  const streamStartedAt = capture.streamStartedAt ?? Date.now();
  const timestampedFinals: TimestampedFinal[] = finalTranscripts.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
    receivedAt: t.receivedAt,
  }));
  const finalLatency = computeFinalTranscriptLatency(timestampedFinals, streamStartedAt);

  // B6. First Partial Latency
  const partials = capture.transcripts.filter((t) => !t.isFinal);
  const timestampedPartials: TimestampedPartial[] = partials.map((t) => ({
    text: t.text,
    receivedAt: t.receivedAt,
  }));
  const firstPartial = computeFirstPartialLatency(timestampedPartials, streamStartedAt);

  // B7. Real-Time Factor (RTF)
  const rtfResult = computeRtf(timestampedFinals, AUDIO_DURATION_SECONDS, streamStartedAt);

  // --- Build structured metrics report ---
  const metricsReport = {
    timestamp: new Date().toISOString(),
    pipeline: E2E_PIPELINE_NAME,
    audioDurationSec: AUDIO_DURATION_SECONDS,
    speechEndSec: SPEECH_END_SECONDS,
    accuracy: {
      wer: { value: werResult.wer, referenceWords: werResult.referenceWords, hypothesisWords: werResult.hypothesisWords, substitutions: werResult.substitutions, deletions: werResult.deletions, insertions: werResult.insertions },
      cer: { value: cerResult.cer, referenceChars: cerResult.referenceChars, hypothesisChars: cerResult.hypothesisChars },
      ser: { value: serResult.ser, totalSegments: serResult.totalSegments, errorSegments: serResult.errorSegments, segmentDetails: serResult.segmentDetails.map((d) => ({ reference: d.reference.text, hypothesis: d.hypothesisCombined, segmentWer: d.segmentWer, covered: d.covered })) },
    },
    latency: {
      finalTranscriptMs: { p50: finalLatency.latencies.p50, p95: finalLatency.latencies.p95, p99: finalLatency.latencies.p99, min: finalLatency.latencies.min, max: finalLatency.latencies.max, mean: finalLatency.latencies.mean, count: finalLatency.latencies.count },
      firstPartialMs: firstPartial.latencyMs,
      rtf: { value: rtfResult.rtf, wallClockMs: rtfResult.wallClockMs },
    },
    reliability: {
      silenceHallucination: { rate: hallucination.rate, totalFinals: hallucination.totalFinals, hallucinatedFinals: hallucination.hallucinatedFinals, hallucinatedTexts: hallucination.hallucinatedTexts },
      taskSuccess: { rate: taskSuccess.rate, totalSegments: taskSuccess.totalSegments, coveredSegments: taskSuccess.coveredSegments },
    },
  };

  // --- Console report (always prints, even on WER failure) ---
  const lines = [
    '='.repeat(72),
    '  TRANSCRIPTION QUALITY METRICS REPORT',
    '='.repeat(72),
    '',
    '  ACCURACY',
    `    Word Error Rate (WER):      ${(werResult.wer * 100).toFixed(1)}%  (threshold: ${(WER_THRESHOLD * 100).toFixed(0)}%)     [lower is better]`,
    `    Character Error Rate (CER):  ${(cerResult.cer * 100).toFixed(1)}%                        [lower is better]`,
    `    Sentence Error Rate (SER):   ${(serResult.ser * 100).toFixed(1)}%  (${serResult.errorSegments}/${serResult.totalSegments} segments)     [lower is better]`,
    '',
    '  LATENCY',
    `    Final Transcript Latency:    (n=${finalLatency.latencies.count})               [lower is better]`,
    `      P50: ${finalLatency.latencies.p50.toFixed(0)} ms  P95: ${finalLatency.latencies.p95.toFixed(0)} ms  P99: ${finalLatency.latencies.p99.toFixed(0)} ms`,
    `      Min: ${finalLatency.latencies.min.toFixed(0)} ms  Max: ${finalLatency.latencies.max.toFixed(0)} ms  Mean: ${finalLatency.latencies.mean.toFixed(0)} ms`,
    `    First Partial Latency:       ${firstPartial.latencyMs != null ? `${firstPartial.latencyMs.toFixed(0)} ms` : 'N/A (no partials)'}     [lower is better]`,
    `    Real-Time Factor (RTF):      ${rtfResult.rtf.toFixed(3)}  (${rtfResult.wallClockMs.toFixed(0)} ms / ${rtfResult.audioDurationSec}s audio)     [lower is better, <1.0 = faster than realtime]`,
    '',
    '  RELIABILITY',
    `    Silence Hallucination Rate:  ${(hallucination.rate * 100).toFixed(1)}%  (${hallucination.hallucinatedFinals}/${hallucination.totalFinals} finals)     [lower is better]`,
    `    Task Success Rate:           ${(taskSuccess.rate * 100).toFixed(1)}%  (${taskSuccess.coveredSegments}/${taskSuccess.totalSegments} segments covered)     [higher is better]`,
    '',
    '='.repeat(72),
  ];
  console.log('\n' + lines.join('\n') + '\n');

  // --- Attach structured report as artifact (before assertions so it survives failures) ---
  await test.info().attach('metrics-report.json', {
    body: JSON.stringify(metricsReport, null, 2),
    contentType: 'application/json',
  });

  // --- C. WER threshold assertion ---
  console.log('\n' + report + '\n');

  expect(
    werResult.wer,
    `WER ${(werResult.wer * 100).toFixed(1)}% exceeds threshold ${(WER_THRESHOLD * 100).toFixed(0)}%.\n${report}`,
  ).toBeLessThanOrEqual(WER_THRESHOLD);

  // --- D. UI display matches WebSocket output ---
  expect(domTranscriptText.length, 'DOM should display transcript text').toBeGreaterThan(0);

  const normalizedDom = domTranscriptText.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedWs = hypothesisText.toLowerCase().replace(/\s+/g, ' ').trim();
  const domWords = normalizedDom.split(' ').filter(Boolean);
  const wsWords = new Set(normalizedWs.split(' '));
  const overlap = domWords.filter((w) => wsWords.has(w)).length;
  expect(
    overlap / domWords.length,
    `DOM-WS overlap too low: ${overlap}/${domWords.length} words match`,
  ).toBeGreaterThan(0.5);
});
