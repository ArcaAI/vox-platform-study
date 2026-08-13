/**
 * @arcaai/vox — external microphones / injected MediaStreams
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Every contract (Lanes A–D) was landed against Vitest doubles: fake
 * `MediaStream`s whose `stop()` flips a plain string field, a mocked
 * `AudioMixer`, a mocked store. Those prove the LOGIC. They cannot prove the
 * contracts hold against a real browser audio graph — real
 * `MediaStreamTrack.readyState` transitions, a real `AudioContext`, the real
 * `@arcaai/room` `AudioMixer`, and a real `AnalyserNode` driving the level
 * meter the silent-uplink watchdog rides on. That gap is this suite.
 *
 * Synthetic external microphones are built the way an integrator builds a
 * file-backed or virtual source (`apps/compat-playground/src/lib/file-audio-source.ts`):
 * a `MediaStreamAudioDestinationNode` fed by an `OscillatorNode` (signal) or a
 * `ConstantSourceNode` at 0 (the RC-4 live-but-silent case). No physical
 * microphone, no `getUserMedia`, no device permission — the streams are real
 * `MediaStream`s all the same.
 *
 * SCOPE / WHAT IS NOT ASSERTED HERE
 * ---------------------------------
 * The harness stubs exactly one collaborator — the `PluginManager` — because
 * the STT/VAD/noise-filter stack needs ONNX/WASM models and a live gateway,
 * and no contract depends on it (see `e2e/fixtures/task612-harness.tsx`).
 * Consequently this suite deliberately does NOT assert uplink bitrate or
 * arriving transcripts: with a stubbed pipeline `audioUplinkBitrate` would be
 * reporting the stub's own numbers, not the SDK's. Those belong to a live-stack
 * run (gateway on :8868 + a real `pipelineId`), which this Playwright project
 * has never had a fixture for.
 *
 * The harness page + bundle are separate from `index.html`/`e2e-bundle.mjs` on
 * purpose: that bundle is emitted with `react`, `valibot`, `@arcaai/stt`, …
 * left EXTERNAL, and the page carries no import map, so its bare specifiers do
 * not resolve in a browser. This bundle is built with nothing external.
 */

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const HARNESS_ENTRY = path.join(PACKAGE_ROOT, 'e2e/fixtures/task612-harness.tsx');
const HARNESS_BUNDLE = path.join(PACKAGE_ROOT, 'e2e/fixtures/dist/task612-harness.mjs');
const ESBUILD = path.join(PACKAGE_ROOT, 'node_modules/.bin/esbuild');

type CallResult = { ok: true } | { ok: false; name: string; code: string | null; message: string };

interface HarnessApi {
  makeTone(frequency?: number): string;
  makeSilent(): string;
  makeDead(): string;
  armed(): string;
  trackStates(id: string): string[];
  trackCount(id: string): number;
  start(options?: { streams?: string[]; pipelineId?: string; dynamicSources?: boolean; language?: string }): Promise<CallResult>;
  stop(): Promise<CallResult>;
  snapshot(): {
    isCapturing: boolean;
    audioLevel: number;
    sourceLevels: number[];
    sourceIds: string[];
    audioSignalState: 'ok' | 'silent';
    audioError: string | null;
    hasActiveStream: boolean;
    initializeCalls: number;
    pluginInitialized: boolean;
  };
  logs(level?: string): string[];
  clearLogs(): void;
}

declare global {
  interface Window {
    __T612: HarnessApi;
    __T612_READY?: boolean;
  }
}

/** The watchdog needs `SILENT_UPLINK_WATCHDOG_MS` (5 s) of zero level, plus slack. */
const WATCHDOG_TIMEOUT_MS = 12_000;

async function armAudio(page: Page): Promise<void> {
  await page.goto('/task612.html');
  await page.waitForFunction(() => window.__T612_READY === true);
  // A real click, not `evaluate` — an `AudioContext` created without user
  // activation stays suspended, and a suspended SOURCE context emits silence,
  // which would turn every tone scenario into a false negative.
  await page.click('#t612-arm');
  await expect.poll(() => page.evaluate(() => window.__T612.armed())).toBe('running');
  await page.evaluate(() => window.__T612.clearLogs());
}

test.describe('external microphones / injected streams', () => {
  test.beforeAll(() => {
    // The harness is bundled here rather than by `tsup` so the suite owns its
    // own fixture end-to-end (`pnpm build` does not know about it). esbuild is
    // already present as tsup's own dependency.
    expect(existsSync(ESBUILD), `esbuild not found at ${ESBUILD} — run pnpm install`).toBe(true);
    execFileSync(
      ESBUILD,
      [
        HARNESS_ENTRY,
        '--bundle',
        '--format=esm',
        '--platform=browser',
        '--target=es2022',
        '--jsx=automatic',
        `--define:process.env.NODE_ENV="production"`,
        `--outfile=${HARNESS_BUNDLE}`,
      ],
      { cwd: PACKAGE_ROOT, stdio: 'pipe' },
    );
  });

  test.beforeEach(async ({ page }) => {
    await armAudio(page);
  });

  // =========================================================================
  // 1. Injected single stream, capture-first start.
  // =========================================================================
  test('an injected tone stream captures with a real, non-zero signal', async ({ page }) => {
    const tone = await page.evaluate(() => window.__T612.makeTone(440));
    expect(await page.evaluate((id) => window.__T612.trackStates(id), tone)).toEqual(['live']);

    const result = await page.evaluate((id) => window.__T612.start({ streams: [id] }), tone);
    expect(result, 'start() with a live injected stream must resolve').toEqual({ ok: true });

    // The level meter samples every 100 ms, and the first tick can land before
    // audio has propagated between the two AudioContexts — so the signal is
    // POLLED, never read once off a snapshot. A single source publishes a
    // 1-entry per-source array whose value IS the session level (there is no
    // mixer to attribute against), so both must go non-zero together.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.__T612.snapshot();
            return Math.min(s.audioLevel, s.sourceLevels[0] ?? 0);
          }),
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);

    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing, 'the SDK reports capturing').toBe(true);
    expect(snapshot.hasActiveStream).toBe(true);
    expect(snapshot.audioError).toBeNull();
    expect(snapshot.sourceLevels).toHaveLength(1);
    expect(snapshot.audioSignalState, 'a stream carrying a tone is never "silent"').toBe('ok');
    // No getUserMedia was involved: the injected stream skipped it entirely.
    expect(await page.evaluate(() => window.__T612.logs('debug'))).toContain('Using caller-supplied source streams (getUserMedia skipped)');

    await page.evaluate(() => window.__T612.stop());
  });

  // =========================================================================
  // 2. Stream REUSE across sessions — the OD-1a ownership contract (Lane B).
  // =========================================================================
  test('a caller-owned stream survives stop() and starts again (OD-1a reuse)', async ({ page }) => {
    const tone = await page.evaluate(() => window.__T612.makeTone(440));

    expect(await page.evaluate((id) => window.__T612.start({ streams: [id] }), tone)).toEqual({ ok: true });
    expect(await page.evaluate(() => window.__T612.stop())).toEqual({ ok: true });

    // THE contract: SDK teardown unwires the caller's stream but never ends it.
    // Pre-Lane-B this read ['ended'] — the RC-3 "empty data on the socket".
    expect(await page.evaluate((id) => window.__T612.trackStates(id), tone), 'stop() must not end a caller-owned track').toEqual(['live']);

    const second = await page.evaluate((id) => window.__T612.start({ streams: [id] }), tone);
    expect(second, 'the SAME stream object must be reusable in the next session').toEqual({ ok: true });

    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing).toBe(true);
    expect(snapshot.initializeCalls, 'both sessions reached plugin initialization').toBe(2);

    await page.evaluate(() => window.__T612.stop());
    expect(await page.evaluate((id) => window.__T612.trackStates(id), tone)).toEqual(['live']);
  });

  // =========================================================================
  // 3. Dead stream at start — named error, not a silent zero uplink (Lane A).
  // =========================================================================
  test('a dead injected stream is refused by name (SOURCE_STREAM_NOT_LIVE)', async ({ page }) => {
    const dead = await page.evaluate(() => window.__T612.makeDead());
    expect(await page.evaluate((id) => window.__T612.trackStates(id), dead), 'the fixture really is dead').toEqual(['ended']);

    const result = await page.evaluate((id) => window.__T612.start({ streams: [id] }), dead);

    expect(result.ok, 'start() must reject a dead stream instead of streaming zeros').toBe(false);
    if (result.ok) return; // narrowing only
    expect(result.name).toBe('AgenticError');
    expect(result.code).toBe('SOURCE_STREAM_NOT_LIVE');
    // The message names the offending entry so an integrator can find it.
    expect(result.message).toContain('sourceStreams[0]');
    expect(result.message).toContain('no live audio track');

    // A refused start leaves no session behind.
    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing).toBe(false);
    expect(snapshot.pluginInitialized, 'validation runs BEFORE plugin initialization').toBe(false);
    expect(snapshot.initializeCalls).toBe(0);
  });

  // =========================================================================
  // 4. Start race — capture-shaped options are never dropped silently (Lane C).
  // =========================================================================
  test('a second start carrying sourceStreams rejects with CAPTURE_OPTIONS_DROPPED', async ({ page }) => {
    // First start is plain (no sources) — the shape of an STT hook winning the
    // race against the capture hook that carries the external microphones, so
    // the session opens on the DEFAULT mic exactly as RC-2 describes. This is
    // the ONE test here that needs a capture device: it relies on the fake
    // devices the chromium/firefox projects provision in playwright.config.ts.
    expect(await page.evaluate(() => window.__T612.start({ pipelineId: 'pipe-e2e' }))).toEqual({ ok: true });

    const tone = await page.evaluate(() => window.__T612.makeTone(660));
    const result = await page.evaluate((id) => window.__T612.start({ streams: [id] }), tone);

    expect(result.ok, 'the dropped-sources call must surface as an error, not a log line').toBe(false);
    if (result.ok) return; // narrowing only
    expect(result.name).toBe('AgenticError');
    expect(result.code).toBe('CAPTURE_OPTIONS_DROPPED');
    expect(result.message).toContain('sourceStreams');

    // The log-based triage path is kept alongside the throw.
    const warnings = await page.evaluate(() => window.__T612.logs('warn'));
    expect(warnings.join('\n')).toContain('capture-shaped options were DROPPED');

    // The running session is untouched by the refused call, and the rejected
    // call's own stream was never taken over.
    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing).toBe(true);
    expect(snapshot.initializeCalls).toBe(1);
    expect(await page.evaluate((id) => window.__T612.trackStates(id), tone)).toEqual(['live']);

    await page.evaluate(() => window.__T612.stop());
  });

  // =========================================================================
  // 5. Silent live stream on a STREAMING session — the watchdog (Lane D, RC-4).
  // =========================================================================
  test('a silent injected stream flips audioSignalState to "silent" within the watchdog window', async ({ page }) => {
    const silent = await page.evaluate(() => window.__T612.makeSilent());
    // Structurally perfect input: a live track on a running graph, every
    // sample zero. Nothing before Lane D distinguished this from real audio.
    expect(await page.evaluate((id) => window.__T612.trackStates(id), silent)).toEqual(['live']);

    expect(await page.evaluate((id) => window.__T612.start({ streams: [id], pipelineId: 'pipe-e2e' }), silent)).toEqual({ ok: true });

    await expect
      .poll(() => page.evaluate(() => window.__T612.snapshot().audioSignalState), { timeout: WATCHDOG_TIMEOUT_MS })
      .toBe('silent');

    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing, 'the session keeps running — this is a diagnosis, not a teardown').toBe(true);
    expect(snapshot.audioLevel).toBe(0);

    const warnings = await page.evaluate(() => window.__T612.logs('warn'));
    expect(warnings.join('\n')).toContain('has sent silence');

    // The verdict does not outlive the session that earned it.
    await page.evaluate(() => window.__T612.stop());
    expect(await page.evaluate(() => window.__T612.snapshot().audioSignalState)).toBe('ok');
  });

  // =========================================================================
  // 6. Two injected streams → the real AudioMixer path.
  // =========================================================================
  test('two injected streams take the mixer path with per-source levels', async ({ page }) => {
    const [low, high] = await page.evaluate(() => [window.__T612.makeTone(330), window.__T612.makeTone(550)]);

    expect(await page.evaluate(([a, b]) => window.__T612.start({ streams: [a, b] }), [low, high])).toEqual({ ok: true });

    // The mixer's per-source analysers own this array — one entry per source.
    // The array reaches length 2 as soon as monitoring starts, which is BEFORE
    // its first analyser read has audio in it, so the poll must be on the
    // levels themselves (counting non-zero entries keeps the failure message
    // readable: "expected 2, received 1").
    await expect
      .poll(() => page.evaluate(() => window.__T612.snapshot().sourceLevels.filter((level) => level > 0).length), { timeout: 8000 })
      .toBe(2);

    // The MIXED meter is a second, independent timer — polled separately for
    // the same reason.
    await expect
      .poll(() => page.evaluate(() => window.__T612.snapshot().audioLevel), { timeout: 8000 })
      .toBeGreaterThan(0);

    const snapshot = await page.evaluate(() => window.__T612.snapshot());
    expect(snapshot.isCapturing).toBe(true);
    expect(snapshot.sourceIds, 'each mixed source is addressable').toEqual(['source-1', 'source-2']);

    // Mixer teardown (`dispose()` → `removeSource`) honours ownership too:
    // `stopTracksOnRemove: false` is passed for every caller-owned source.
    await page.evaluate(() => window.__T612.stop());
    expect(await page.evaluate(([a, b]) => [window.__T612.trackStates(a), window.__T612.trackStates(b)], [low, high])).toEqual([['live'], ['live']]);
    expect(await page.evaluate(() => window.__T612.snapshot().sourceLevels)).toEqual([]);
  });
});
