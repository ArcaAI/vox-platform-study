import { expect, test, type Page, type WebSocket as PwWebSocket } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  computeFinalTranscriptLatency,
  computeFirstPartialLatency,
  computeRtf,
  type TimestampedFinal,
  type TimestampedPartial,
} from './helpers/latency-metrics.js';
import { computeHallucinationRate, computeSer, computeTaskSuccess, type TranscriptFinal } from './helpers/segment-metrics.js';
import { concatenateSegmentTexts, parseGroundTruth } from './helpers/transcript-parser.js';
import { computeCer, computeWer, formatWerReport } from './helpers/wer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DRAIN_IDLE_TIMEOUT_MS = 5_000;
export const DRAIN_POLL_INTERVAL_MS = 500;
export const DRAIN_MAX_WAIT_MS = 30_000;

/** Shared quality thresholds (same for all test cases initially). */
export const EXPECTED = {
  wer: 20, // %
  cer: 10, // %
  ser: 60, // %
  finalLatencyP50: 500, // ms
  finalLatencyP95: 1000, // ms
  finalLatencyMean: 750, // ms
  firstPartial: 2000, // ms (from speech start, not stream start)
  rtf: 1.0,
  hallucination: 1, // %
  taskSuccess: 80, // %
};

// ---------------------------------------------------------------------------
// Types matching WS transcript messages from stt-v2
// ---------------------------------------------------------------------------

export interface WsWordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface WsTranscriptMessage {
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

export interface WsStatusMessage {
  type: 'status';
  status: string;
  message: string;
}

export type WsMessage = WsTranscriptMessage | WsStatusMessage | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// WebSocket capture
// ---------------------------------------------------------------------------

export interface WsCapture {
  transcripts: Array<WsTranscriptMessage & { receivedAt: number }>;
  statuses: Array<WsStatusMessage & { receivedAt: number }>;
  all: Array<WsMessage & { receivedAt: number }>;
  streamStartedAt: number | null;
}

export function setupWsCapture(page: Page): WsCapture {
  const capture: WsCapture = { transcripts: [], statuses: [], all: [], streamStartedAt: null };

  page.on('websocket', (ws: PwWebSocket) => {
    if (!ws.url().includes('/ws/stt')) return;

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
// Auth injection
// ---------------------------------------------------------------------------

export async function injectAuth(page: Page): Promise<void> {
  const apiKey = process.env.PLAYGROUND_API_KEY;
  const tenantId = process.env.PLAYGROUND_TENANT_ID;

  if (!apiKey || !tenantId) {
    throw new Error('Missing PLAYGROUND_API_KEY or PLAYGROUND_TENANT_ID environment variables. ' + 'Set them before running E2E tests.');
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
// Drain helper
// ---------------------------------------------------------------------------

export async function drainTranscripts(capture: WsCapture): Promise<void> {
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
// Audio track capture / mute
// ---------------------------------------------------------------------------

export async function setupAudioTrackCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).__e2eMediaStreams = [] as MediaStream[];
    navigator.mediaDevices.getUserMedia = async function (constraints?: MediaStreamConstraints) {
      const stream = await orig(constraints);
      (window as any).__e2eMediaStreams.push(stream);
      return stream;
    };
  });
}

export async function muteAudioTracks(page: Page): Promise<void> {
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
// Core test runner
// ---------------------------------------------------------------------------

export interface TranscriptionTestParams {
  page: Page;
  pipelineName: string;
  groundTruthPath: string;
  audioDurationSeconds: number;
  speechStartSeconds: number;
  speechEndSeconds: number;
}

export async function runTranscriptionTest({
  page,
  pipelineName,
  groundTruthPath,
  audioDurationSeconds,
  speechStartSeconds,
  speechEndSeconds,
}: TranscriptionTestParams): Promise<void> {
  // Load ground truth
  const groundTruth = readFileSync(groundTruthPath, 'utf-8');
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

  // 5. Select the pipeline by name
  await pipelineSelect.click();
  await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5_000 });
  const pipelineOption = page.getByRole('option', { name: pipelineName, exact: true });
  if (await pipelineOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await pipelineOption.click();
  } else {
    await page.keyboard.press('Escape');
    console.warn(`E2E pipeline "${pipelineName}" not found, using default`);
  }

  // 6. Start streaming
  const startButton = page.getByRole('button', { name: 'Connect & Stream' });
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();
  await expect(page.getByText('streaming', { exact: true })).toBeVisible({ timeout: 30_000 });

  // 7. Verify streaming stays active
  await page.waitForTimeout(3_000);
  const hasServerError = await page.locator('text=Internal server error').isVisible();
  expect(hasServerError, 'Backend returned "Internal server error". Check STT service logs and ensure the pipeline exists.').toBe(false);
  await expect(page.getByText('streaming', { exact: true }), 'Streaming status lost -- backend may have errored or disconnected.').toBeVisible();

  // 8. Wait for audio playback, then mute tracks to prevent Chrome loop
  await page.waitForTimeout(audioDurationSeconds * 1000);
  await muteAudioTracks(page);

  // 9. Drain: wait for backend to flush remaining finals
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

  // Verify no looped audio leaked through (allow small tolerance for STT processing latency)
  const loopDetectionToleranceSec = 5;
  const maxStartTime = Math.max(...finalTranscripts.map((t) => t.startTime), 0);
  expect(
    maxStartTime,
    `Looped audio detected: transcript at ${maxStartTime.toFixed(1)}s exceeds audio duration. ` +
      `Audio track muting may not have prevented Chrome's fake audio loop.`,
  ).toBeLessThan(audioDurationSeconds + loopDetectionToleranceSec);

  // 12. DOM transcript for cross-validation
  const domTexts = await page.locator('.group p').allInnerTexts();
  const domTranscriptText = domTexts.join(' ').trim();

  // --- Always attach WebSocket data (before assertions so they survive failures) ---
  const stripMeta = <T extends { receivedAt: number }>({ receivedAt, ...raw }: T): Omit<T, 'receivedAt'> => raw;
  await test.info().attach('ws-messages-all.json', {
    body: JSON.stringify(capture.all.map(stripMeta), null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('ws-transcripts-final.json', {
    body: JSON.stringify(finalTranscripts.map(stripMeta), null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('ws-statuses.json', {
    body: JSON.stringify(capture.statuses.map(stripMeta), null, 2),
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

  // --- B. Compute all metrics ---
  const werResult = computeWer(referenceText, hypothesisText);
  const report = formatWerReport(werResult, 'basic', EXPECTED.wer / 100, referenceText, hypothesisText);

  const cerResult = computeCer(referenceText, hypothesisText);

  const transcriptFinals: TranscriptFinal[] = finalTranscripts.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
  }));
  const serResult = computeSer(expectedSegments, transcriptFinals);

  const taskSuccess = computeTaskSuccess(expectedSegments, transcriptFinals);

  const allFinals = capture.transcripts.filter((t) => t.isFinal);
  const allTranscriptFinals: TranscriptFinal[] = allFinals.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
  }));
  const hallucination = computeHallucinationRate(allTranscriptFinals, speechEndSeconds);

  const streamStartedAt = capture.streamStartedAt ?? Date.now();
  const timestampedFinals: TimestampedFinal[] = finalTranscripts.map((t) => ({
    text: t.text,
    startTime: t.startTime,
    endTime: t.endTime,
    receivedAt: t.receivedAt,
  }));
  const finalLatency = computeFinalTranscriptLatency(timestampedFinals, streamStartedAt);

  const partials = capture.transcripts.filter((t) => !t.isFinal);
  const timestampedPartials: TimestampedPartial[] = partials.map((t) => ({
    text: t.text,
    receivedAt: t.receivedAt,
  }));
  const speechStartedAt = streamStartedAt + speechStartSeconds * 1000;
  const firstPartial = computeFirstPartialLatency(timestampedPartials, speechStartedAt);

  const rtfResult = computeRtf(timestampedFinals, audioDurationSeconds, streamStartedAt);

  // --- Build structured metrics report ---
  const metricsReport = {
    timestamp: new Date().toISOString(),
    pipeline: pipelineName,
    audioDurationSec: audioDurationSeconds,
    speechEndSec: speechEndSeconds,
    accuracy: {
      wer: {
        value: werResult.wer,
        referenceWords: werResult.referenceWords,
        hypothesisWords: werResult.hypothesisWords,
        substitutions: werResult.substitutions,
        deletions: werResult.deletions,
        insertions: werResult.insertions,
      },
      cer: { value: cerResult.cer, referenceChars: cerResult.referenceChars, hypothesisChars: cerResult.hypothesisChars },
      ser: {
        value: serResult.ser,
        totalSegments: serResult.totalSegments,
        errorSegments: serResult.errorSegments,
        segmentDetails: serResult.segmentDetails.map((d) => ({
          reference: d.reference.text,
          hypothesis: d.hypothesisCombined,
          segmentWer: d.segmentWer,
          covered: d.covered,
        })),
      },
    },
    latency: {
      finalTranscriptMs: {
        p50: finalLatency.latencies.p50,
        p95: finalLatency.latencies.p95,
        p99: finalLatency.latencies.p99,
        min: finalLatency.latencies.min,
        max: finalLatency.latencies.max,
        mean: finalLatency.latencies.mean,
        count: finalLatency.latencies.count,
      },
      firstPartialMs: firstPartial.latencyMs,
      rtf: { value: rtfResult.rtf, wallClockMs: rtfResult.wallClockMs },
    },
    reliability: {
      silenceHallucination: {
        rate: hallucination.rate,
        totalFinals: hallucination.totalFinals,
        hallucinatedFinals: hallucination.hallucinatedFinals,
        hallucinatedTexts: hallucination.hallucinatedTexts,
      },
      taskSuccess: { rate: taskSuccess.rate, totalSegments: taskSuccess.totalSegments, coveredSegments: taskSuccess.coveredSegments },
    },
  };

  // --- Console report ---
  const badge = (actual: number, expected: number, lower: boolean) => {
    const ok = lower ? actual <= expected : actual >= expected;
    return ok ? ' PASS ' : ' FAIL ';
  };

  const W = 78;
  const hr = '-'.repeat(W);
  const dhr = '='.repeat(W);

  const results = [
    badge(werResult.wer * 100, EXPECTED.wer, true),
    badge(cerResult.cer * 100, EXPECTED.cer, true),
    badge(serResult.ser * 100, EXPECTED.ser, true),
    badge(finalLatency.latencies.p50, EXPECTED.finalLatencyP50, true),
    badge(finalLatency.latencies.p95, EXPECTED.finalLatencyP95, true),
    badge(finalLatency.latencies.mean, EXPECTED.finalLatencyMean, true),
    firstPartial.latencyMs != null ? badge(firstPartial.latencyMs, EXPECTED.firstPartial, true) : ' N/A  ',
    badge(rtfResult.rtf, EXPECTED.rtf, true),
    badge(hallucination.rate * 100, EXPECTED.hallucination, true),
    badge(taskSuccess.rate * 100, EXPECTED.taskSuccess, false),
  ];
  const passCount = results.filter((r) => r.includes('PASS')).length;
  const failCount = results.filter((r) => r.includes('FAIL')).length;

  const row = (label: string, actual: string, op: string, expected: string, status: string, note = '') => {
    const left = `  ${label}`;
    const mid = `${actual.padStart(10)}  ${op} ${expected.padEnd(10)}`;
    const right = `[${status.trim()}]${note ? '  ' + note : ''}`;
    return `${left.padEnd(36)}${mid}  ${right}`;
  };

  const lines = [
    '',
    dhr,
    `  TRANSCRIPTION QUALITY METRICS REPORT`,
    `  ${new Date().toISOString()}`,
    dhr,
    '',
    `  ACCURACY`,
    hr,
    row('Word Error Rate (WER)', `${(werResult.wer * 100).toFixed(1)}%`, '<=', `${EXPECTED.wer}%`, badge(werResult.wer * 100, EXPECTED.wer, true)),
    row(
      'Character Error Rate (CER)',
      `${(cerResult.cer * 100).toFixed(1)}%`,
      '<=',
      `${EXPECTED.cer}%`,
      badge(cerResult.cer * 100, EXPECTED.cer, true),
    ),
    row(
      'Sentence Error Rate (SER)',
      `${(serResult.ser * 100).toFixed(1)}%`,
      '<=',
      `${EXPECTED.ser}%`,
      badge(serResult.ser * 100, EXPECTED.ser, true),
      `(${serResult.errorSegments}/${serResult.totalSegments} segments)`,
    ),
    '',
    `  LATENCY`,
    hr,
    `  Final Transcript Latency (n=${finalLatency.latencies.count}):`,
    row(
      '  P50',
      `${finalLatency.latencies.p50.toFixed(0)} ms`,
      '<=',
      `${EXPECTED.finalLatencyP50} ms`,
      badge(finalLatency.latencies.p50, EXPECTED.finalLatencyP50, true),
    ),
    row(
      '  P95',
      `${finalLatency.latencies.p95.toFixed(0)} ms`,
      '<=',
      `${EXPECTED.finalLatencyP95} ms`,
      badge(finalLatency.latencies.p95, EXPECTED.finalLatencyP95, true),
    ),
    row(
      '  Mean',
      `${finalLatency.latencies.mean.toFixed(0)} ms`,
      '<=',
      `${EXPECTED.finalLatencyMean} ms`,
      badge(finalLatency.latencies.mean, EXPECTED.finalLatencyMean, true),
    ),
    `    P99: ${finalLatency.latencies.p99.toFixed(0)} ms  |  Min: ${finalLatency.latencies.min.toFixed(0)} ms  |  Max: ${finalLatency.latencies.max.toFixed(0)} ms`,
    row(
      'First Partial Latency',
      firstPartial.latencyMs != null ? `${firstPartial.latencyMs.toFixed(0)} ms` : 'N/A',
      '<=',
      `${EXPECTED.firstPartial} ms`,
      firstPartial.latencyMs != null ? badge(firstPartial.latencyMs, EXPECTED.firstPartial, true) : ' N/A  ',
      '(from speech start)',
    ),
    row(
      'Real-Time Factor (RTF)',
      rtfResult.rtf.toFixed(3),
      '<',
      ` ${EXPECTED.rtf.toFixed(1)} `,
      badge(rtfResult.rtf, EXPECTED.rtf, true),
      `(${rtfResult.wallClockMs.toFixed(0)} ms / ${rtfResult.audioDurationSec}s audio)`,
    ),
    '',
    `  RELIABILITY`,
    hr,
    row(
      'Silence Hallucination',
      `${(hallucination.rate * 100).toFixed(1)}%`,
      '<=',
      `${EXPECTED.hallucination}%`,
      badge(hallucination.rate * 100, EXPECTED.hallucination, true),
      `(${hallucination.hallucinatedFinals}/${hallucination.totalFinals} finals)`,
    ),
    row(
      'Task Success Rate',
      `${(taskSuccess.rate * 100).toFixed(1)}%`,
      '>=',
      `${EXPECTED.taskSuccess}%`,
      badge(taskSuccess.rate * 100, EXPECTED.taskSuccess, false),
      `(${taskSuccess.coveredSegments}/${taskSuccess.totalSegments} segments)`,
    ),
    '',
    hr,
    `  Summary:  ${passCount} passed  |  ${failCount} failed  |  ${results.length} total`,
    dhr,
    '',
  ];
  console.log(lines.join('\n'));

  // --- Attach structured report as artifact ---
  await test.info().attach('metrics-report.json', {
    body: JSON.stringify(metricsReport, null, 2),
    contentType: 'application/json',
  });

  // --- C. WER threshold assertion ---
  console.log('\n' + report + '\n');

  expect(werResult.wer, `WER ${(werResult.wer * 100).toFixed(1)}% exceeds threshold ${EXPECTED.wer.toFixed(0)}%.\n${report}`).toBeLessThanOrEqual(
    EXPECTED.wer / 100,
  );

  // --- D. UI display matches WebSocket output ---
  expect(domTranscriptText.length, 'DOM should display transcript text').toBeGreaterThan(0);

  const normalizedDom = domTranscriptText.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedWs = hypothesisText.toLowerCase().replace(/\s+/g, ' ').trim();
  const domWords = normalizedDom.split(' ').filter(Boolean);
  const wsWords = new Set(normalizedWs.split(' '));
  const overlap = domWords.filter((w) => wsWords.has(w)).length;
  expect(overlap / domWords.length, `DOM-WS overlap too low: ${overlap}/${domWords.length} words match`).toBeGreaterThan(0.5);
}
