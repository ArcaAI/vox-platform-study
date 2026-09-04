/**
 * Optional audio features must default OFF.
 *
 * VAD, noise cancellation, and medical-NER auto-extract are OPTIONAL. A consumer
 * that never states a preference (the common `@arcaai/vox/compat` shape, where
 * `AgenticProvider` falls through to `cfg.audio ?? DEFAULT_AUDIO_CONFIG`) must NOT
 * inherit them — and therefore must NOT trigger an unsolicited Silero (jsDelivr)
 * or RNNoise model fetch on the first `audio.start()`.
 *
 * STT is the core product capability, not an optional add-on, so it stays ON.
 *
 * Three claims are pinned:
 *  1. The default config objects themselves declare the optional stages OFF and
 *     STT ON.
 *  2. `PluginManager` resolves the DEFAULT audio config into a pipeline config
 *     with VAD/noise disabled and STT enabled.
 *  3. A `TranscriptionPipeline` built from those defaults never CONSTRUCTS the
 *     VAD/noise stages — so `@arcaai/vad` / `@arcaai/noise-filter` are never
 *     imported and no model is fetched. A positive control proves the same
 *     pipeline DOES construct VAD once a consumer opts in.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager } from '../core/PluginManager';
import { TranscriptionPipeline } from '../core/TranscriptionPipeline';
import { DEFAULT_AUDIO_CONFIG, DEFAULT_LOCAL_CONFIG } from '../types';
import { DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG } from '../types/pipeline';
import { createMockLogger } from './setup';

const createVAD = vi.fn();
const createNoiseFilter = vi.fn();

vi.mock('@arcaai/vad', () => ({ createVAD: (...args: unknown[]) => createVAD(...args) }));
vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: (...args: unknown[]) => createNoiseFilter(...args) }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn(() => ({ init: vi.fn(), on: vi.fn(), setStreamingTransport: vi.fn() })) }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

describe('optional audio features default OFF (config objects)', () => {
  it('DEFAULT_AUDIO_CONFIG declares VAD and noise-filter OFF, STT ON', () => {
    // Whole-object matchers — the fields are typed `T | boolean | undefined`,
    // so direct `.enabled` access would not narrow.
    expect(DEFAULT_AUDIO_CONFIG.vad).toMatchObject({ enabled: false });
    expect(DEFAULT_AUDIO_CONFIG.noiseFilter).toMatchObject({ enabled: false });
    // STT is the core capability — it stays enabled by default.
    expect(DEFAULT_AUDIO_CONFIG.stt).toMatchObject({ enabled: true });
  });

  it('DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG (the pipeline-level fallback) also declares VAD and noise-filter OFF', () => {
    // TASK-865: a `new TranscriptionPipeline({ stt })` that names neither stage
    // must not inherit a client model from the pipeline's OWN defaults either —
    // the directive is "nothing loads unless the host opts in", at every layer.
    expect(DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG.vad.enabled).toBe(false);
    expect(DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG.noiseFilter.enabled).toBe(false);
    expect(DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG.stt.enabled).toBe(true);
  });

  it('DEFAULT_LOCAL_CONFIG does NOT auto-extract medical NER by default', () => {
    expect(DEFAULT_LOCAL_CONFIG.ner.autoExtract).toBe(false);
    // Already-off features stay off (regression guard, not a change).
    expect(DEFAULT_LOCAL_CONFIG.diarization.enabled).toBe(false);
    expect(DEFAULT_LOCAL_CONFIG.voiceEmbedding.modelId).toBe('');
  });
});

describe('PluginManager resolves the DEFAULT audio config to a gated pipeline', () => {
  it('vad + noiseFilter resolve DISABLED, stt resolves ENABLED', () => {
    const manager = new PluginManager(DEFAULT_AUDIO_CONFIG, createMockLogger(), undefined, false);
    const pipelineConfig = manager.getTranscriptionPipelineConfig();

    expect(pipelineConfig.vad.enabled).toBe(false);
    expect(pipelineConfig.noiseFilter.enabled).toBe(false);
    expect(pipelineConfig.stt.enabled).toBe(true);
  });

  it('a PluginManager constructed with NO audio config resolves both client stages DISABLED', () => {
    const manager = new PluginManager(undefined, createMockLogger(), undefined, false);
    const pipelineConfig = manager.getTranscriptionPipelineConfig();

    expect(pipelineConfig.vad.enabled).toBe(false);
    expect(pipelineConfig.noiseFilter.enabled).toBe(false);
  });
});

describe('a default mount never constructs the optional stages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TranscriptionPipeline built from defaults imports neither @arcaai/vad nor @arcaai/noise-filter', async () => {
    const manager = new PluginManager(DEFAULT_AUDIO_CONFIG, createMockLogger(), undefined, false);
    const cfg = manager.getTranscriptionPipelineConfig();

    // STT is isolated (enabled:false) so the run does not depend on backend/socket
    // resolution — this test is about the OPTIONAL stages only.
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: cfg.noiseFilter,
        vad: cfg.vad,
        stt: { enabled: false, location: 'browser', provider: 'local' },
      },
      createMockLogger(),
    );

    await pipeline.start({
      track: { kind: 'audio' } as unknown as MediaStreamTrack,
      audioContext: {} as unknown as AudioContext,
    });

    expect(createVAD).not.toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
    expect(pipeline.getProcessor('vad')).toBeFalsy();
    expect(pipeline.getProcessor('noiseFilter')).toBeFalsy();
  });

  it('a TranscriptionPipeline built with NO config (pipeline-level defaults) imports neither package', async () => {
    const pipeline = new TranscriptionPipeline({ stt: { enabled: false, location: 'browser', provider: 'local' } }, createMockLogger());

    await pipeline.start({
      track: { kind: 'audio' } as unknown as MediaStreamTrack,
      audioContext: {} as unknown as AudioContext,
    });

    expect(createVAD).not.toHaveBeenCalled();
    expect(createNoiseFilter).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — the SAME pipeline DOES construct VAD once a consumer opts in (stage enabled AND clientInference.allow)', async () => {
    createVAD.mockResolvedValue({ init: vi.fn(), on: vi.fn(), isEnabled: () => true, processedTrack: null });

    const pipeline = new TranscriptionPipeline(
      {
        // TASK-865: `enabled: true` alone is no longer enough — see
        // `client-inference-gate.task865.test.ts`. The explicit allow is what
        // proves the gate can still be opened by a host that means it.
        clientInference: { allow: true },
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
