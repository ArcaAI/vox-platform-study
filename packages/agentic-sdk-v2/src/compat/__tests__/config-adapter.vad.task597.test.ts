/**
 * compat config adapter — VAD switch, and proof that `enabled:false` genuinely
 * skips the stage (TASK-597).
 *
 * Two separate claims are pinned here, because passing the first without the
 * second would be a config knob that quietly does nothing:
 *
 *  1. `V1AudioSettings.voiceActivityDetection` maps onto `AudioPluginConfig.vad`,
 *     additively — a v1 config that omits it produces the pre-597 object byte
 *     for byte, so the frozen contract is untouched.
 *  2. A `{ enabled: false }` stage is never CONSTRUCTED. `TranscriptionPipeline`
 *     only walks `getEnabledStages()`, so the processor factory (and therefore
 *     the `@arcaai/vad` / `@arcaai/noise-filter` dynamic import) never runs and
 *     the audio track is never routed through it. That is what makes "disabled"
 *     mean ungated audio rather than a bypassed-but-loaded processor.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapV1ConfigToAgenticConfig } from '../config-adapter';
import { PluginManager } from '../../core/PluginManager';
import { TranscriptionPipeline } from '../../core/TranscriptionPipeline';
import { createMockLogger } from '../../__tests__/setup';
import type { AudioPluginConfig } from '../../types';

const createVAD = vi.fn();
const createNoiseFilter = vi.fn();

vi.mock('@arcaai/vad', () => ({ createVAD: (...args: unknown[]) => createVAD(...args) }));
vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: (...args: unknown[]) => createNoiseFilter(...args) }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn(() => ({ init: vi.fn(), on: vi.fn(), setStreamingTransport: vi.fn() })) }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

const BASE = {
  apiEndpoint: 'https://api.test',
  websocketUrl: 'wss://api.test',
  credentials: { apiKey: 'k-1' },
};

describe('mapV1ConfigToAgenticConfig — voiceActivityDetection (TASK-597)', () => {
  it('emits a DISABLED vad entry when the v1 config asks for VAD off', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'pipe-1', audioSettings: { voiceActivityDetection: false } });
    expect(cfg.audio?.vad).toEqual({ enabled: false });
  });

  it('emits an ENABLED vad entry when the v1 config asks for VAD on', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'pipe-1', audioSettings: { voiceActivityDetection: true } });
    expect(cfg.audio?.vad).toEqual({ enabled: true });
  });

  it('emits NO vad key when the setting is absent — the frozen v1 mapping is unchanged', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'pipe-1' });
    expect(cfg.audio).not.toHaveProperty('vad');
    // The pre-597 object, verbatim.
    expect(cfg.audio).toEqual({ stt: { enabled: true, provider: 'backend', pipelineId: 'pipe-1', requireTenantClaim: false } });
  });

  it('still maps noiseSuppression alongside it — the two switches are independent', () => {
    const cfg = mapV1ConfigToAgenticConfig({
      ...BASE,
      sttPipelineId: 'pipe-1',
      audioSettings: { noiseSuppression: false, voiceActivityDetection: false },
    });
    expect(cfg.audio?.noiseFilter).toEqual({ enabled: false, level: 'medium' });
    expect(cfg.audio?.vad).toEqual({ enabled: false });
  });
});

describe('a disabled stage is genuinely skipped, not merely bypassed (TASK-597)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Run the adapter output through the real `PluginManager` config resolution. */
  function resolve(audio: AudioPluginConfig | undefined) {
    const manager = new PluginManager(audio ?? {}, createMockLogger(), undefined, false);
    return manager.getTranscriptionPipelineConfig();
  }

  it('PluginManager resolves an adapter "off" into a disabled stage', () => {
    const cfg = mapV1ConfigToAgenticConfig({
      ...BASE,
      sttPipelineId: 'pipe-1',
      audioSettings: { noiseSuppression: false, voiceActivityDetection: false },
    });
    const pipelineConfig = resolve(cfg.audio);

    expect(pipelineConfig.vad.enabled).toBe(false);
    expect(pipelineConfig.noiseFilter.enabled).toBe(false);
    // The noise filter additionally reports `skip` as its location.
    expect(pipelineConfig.noiseFilter.location).toBe('skip');
  });

  it('an OMITTED stage resolves to disabled too — the adapter output REPLACES the defaults, it does not merge', () => {
    // This is the behaviour that makes the new switch necessary in BOTH
    // directions: `AgenticProvider` does `cfg.audio ?? DEFAULT_AUDIO_CONFIG`,
    // and `PluginManager.getConfig()` answers `{enabled:false}` for an absent
    // key — so a compat app that never states a preference gets VAD OFF, not
    // `DEFAULT_AUDIO_CONFIG`'s VAD ON.
    const cfg = mapV1ConfigToAgenticConfig({ ...BASE, sttPipelineId: 'pipe-1' });
    const pipelineConfig = resolve(cfg.audio);

    expect(pipelineConfig.vad.enabled).toBe(false);
    expect(pipelineConfig.noiseFilter.enabled).toBe(false);
  });

  it('TranscriptionPipeline never CONSTRUCTS a disabled stage — no @arcaai/vad import, no processor', async () => {
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: false, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      createMockLogger(),
    );

    await pipeline.start({
      track: { kind: 'audio' } as unknown as MediaStreamTrack,
      audioContext: {} as unknown as AudioContext,
    });

    // The factories are the ONLY place the packages are imported and the only
    // place a processor is created. Never called ⇒ the stage does not exist in
    // the running graph, so the audio reaches STT ungated.
    expect(createVAD).not.toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
    expect(pipeline.getProcessor('vad')).toBeFalsy();
    expect(pipeline.getProcessor('noiseFilter')).toBeFalsy();
  });

  it('POSITIVE CONTROL — the SAME pipeline DOES construct the stage when enabled', async () => {
    // Without this, the assertion above could pass for the wrong reason (a
    // broken mock, a renamed factory, a pipeline that never starts at all).
    createVAD.mockResolvedValue({
      init: vi.fn(),
      on: vi.fn(),
      isEnabled: () => true,
      processedTrack: null,
    });

    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: true, location: 'browser' },
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      createMockLogger(),
    );

    await pipeline.start({
      track: { kind: 'audio' } as unknown as MediaStreamTrack,
      audioContext: {} as unknown as AudioContext,
    });

    expect(createVAD).toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
  });
});
