/**
 * TASK-865 — the client-inference HARD-OFF gate.
 *
 * Owner directive (2026-09-04): "By default, disable all local/client-side AI
 * capabilities such as VAD, noise suppression. Therefore, no need to load VAD
 * model or any AI models in the client side."
 *
 * `DEFAULT_AUDIO_CONFIG` already declares both stages OFF, but "off by default"
 * is not the same as "nothing loads": an OLD host that still ships
 * `vad: { enabled: true }` would re-enable a Silero download without anyone
 * deciding to. So the runtime now IGNORES `enabled: true` for the two client
 * stages unless the host ALSO states `audio.clientInference: { allow: true }`
 * — a new, explicit, documented-as-deprecated-on-arrival switch — and logs a
 * deprecation warning once per pipeline so the mismatch is visible.
 *
 * Three claims:
 *  1. `enabled: true` without the allow ⇒ no `@arcaai/vad` / `@arcaai/noise-filter`
 *     import, no processor, ONE warning naming the ignored stages.
 *  2. `enabled: true` WITH the allow ⇒ the stage is constructed (positive control).
 *  3. `PluginManager` forwards `audio.clientInference` from `AgenticConfig.audio`
 *     into the pipeline config it builds, so the gate is reachable from the
 *     provider config a host actually writes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager } from '../core/PluginManager';
import { TranscriptionPipeline } from '../core/TranscriptionPipeline';
import { createMockLogger } from './setup';

const createVAD = vi.fn();
const createNoiseFilter = vi.fn();

vi.mock('@arcaai/vad', () => ({ createVAD: (...args: unknown[]) => createVAD(...args) }));
vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: (...args: unknown[]) => createNoiseFilter(...args) }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn(() => ({ init: vi.fn(), on: vi.fn(), setStreamingTransport: vi.fn() })) }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

const track = { kind: 'audio' } as unknown as MediaStreamTrack;
const audioContext = {} as unknown as AudioContext;

function processor() {
  return { init: vi.fn(), on: vi.fn(), isEnabled: () => true, processedTrack: null };
}

describe('client-inference gate — explicit enabled:true is IGNORED without clientInference.allow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createVAD.mockResolvedValue(processor());
    createNoiseFilter.mockResolvedValue(processor());
  });

  it('does not construct VAD or the noise filter, and warns ONCE naming both ignored stages', async () => {
    const logger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: true, location: 'browser', level: 'high' },
        vad: { enabled: true, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      logger,
    );

    await pipeline.start({ track, audioContext });

    expect(createVAD).not.toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
    expect(pipeline.getProcessor('vad')).toBeFalsy();
    expect(pipeline.getProcessor('noiseFilter')).toBeFalsy();

    const deprecationWarnings = logger.warn.mock.calls.filter(([message]) => /deprecat/i.test(String(message)));
    expect(deprecationWarnings).toHaveLength(1);
    const [message, meta] = deprecationWarnings[0]!;
    expect(String(message)).toMatch(/client-side/i);
    expect((meta as { attributes?: { ignoredStages?: string[] } }).attributes?.ignoredStages).toEqual(['noiseFilter', 'vad']);
  });

  it('warns for a single ignored stage without naming the other', async () => {
    const logger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: true, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      logger,
    );

    await pipeline.start({ track, audioContext });

    expect(createVAD).not.toHaveBeenCalled();
    const [, meta] = logger.warn.mock.calls.find(([message]) => /deprecat/i.test(String(message)))!;
    expect((meta as { attributes?: { ignoredStages?: string[] } }).attributes?.ignoredStages).toEqual(['vad']);
  });

  it('does not warn at all when neither stage asked to be enabled', async () => {
    const logger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: false, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      logger,
    );

    await pipeline.start({ track, audioContext });

    expect(logger.warn.mock.calls.some(([message]) => /deprecat/i.test(String(message)))).toBe(false);
  });

  it('POSITIVE CONTROL — clientInference.allow: true opens the gate and constructs both stages, without the warning', async () => {
    const logger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        clientInference: { allow: true },
        noiseFilter: { enabled: true, location: 'browser', level: 'high' },
        vad: { enabled: true, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      logger,
    );

    await pipeline.start({ track, audioContext });

    expect(createNoiseFilter).toHaveBeenCalledTimes(1);
    expect(createVAD).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls.some(([message]) => /deprecat/i.test(String(message)))).toBe(false);
  });
});

describe('PluginManager forwards audio.clientInference into the pipeline config', () => {
  it('omits the allow when the host never stated one (the gate stays closed)', () => {
    const manager = new PluginManager({ vad: { enabled: true }, noiseFilter: { enabled: true } }, createMockLogger(), undefined, false);
    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.clientInference?.allow).not.toBe(true);
    // The stage flags themselves are still reported as the host wrote them —
    // the GATE (not the config) is what stops the download.
    expect(cfg.vad.enabled).toBe(true);
    expect(cfg.noiseFilter.enabled).toBe(true);
  });

  it('carries an explicit allow through verbatim', () => {
    const manager = new PluginManager(
      { clientInference: { allow: true }, vad: { enabled: true }, noiseFilter: { enabled: true } },
      createMockLogger(),
      undefined,
      false,
    );

    expect(manager.getTranscriptionPipelineConfig().clientInference).toEqual({ allow: true });
  });

  it('a manager-built pipeline under a plain enabled:true never imports the client packages', async () => {
    vi.clearAllMocks();
    const manager = new PluginManager({ vad: { enabled: true }, noiseFilter: { enabled: true } }, createMockLogger(), undefined, false);
    const cfg = manager.getTranscriptionPipelineConfig();
    const pipeline = new TranscriptionPipeline(
      { ...cfg, stt: { enabled: false, location: 'browser', provider: 'local' } },
      createMockLogger(),
    );

    await pipeline.start({ track, audioContext });

    expect(createVAD).not.toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
  });
});
