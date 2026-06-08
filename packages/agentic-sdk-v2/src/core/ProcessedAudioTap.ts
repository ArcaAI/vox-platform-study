/**
 * @arcaai/vox - createProcessedAudioTap
 *
 * Exposes the GENUINE post-noise-filter audio as a recordable `MediaStream`,
 * using the very same RNNoise `NoiseFilterProcessor` the `TranscriptionPipeline`
 * NoiseFilter stage uses (`NoiseFilter -> VAD -> STT`).
 *
 * Why this exists: some capture paths (e.g. a backend-STT live caption flow)
 * stream the raw mic straight to the server and never drive the full local
 * pipeline, so the pipeline's `getProcessedTrack()` is unavailable. This helper
 * lets such a consumer obtain the real processed PCM for a parallel artifact
 * (e.g. dual capture) from just the raw mic stream.
 *
 * Design notes:
 * - **Opt-in & side-effect-free until called.** Nothing in the SDK invokes this;
 *   the pipeline and all existing audio behavior are untouched.
 * - **Non-destructive tap.** It builds its own processing graph from the raw
 *   track; it never stops the source mic track (teardown of the mic stays the
 *   caller's responsibility, preserving capture ordering).
 * - **Fails loud when genuine DSP is unavailable.** When RNNoise is not
 *   supported in the current browser it throws, so the caller can fall back to
 *   its own approximation rather than silently recording an unfiltered stream.
 */

import type { NoiseCancellationLevel } from '@arcaai/noise-filter';

export interface ProcessedAudioTapOptions {
  /**
   * RNNoise cancellation intensity. Mirrors `TranscriptionPipeline`'s
   * `noiseFilter.level` (default `'high'`).
   */
  level?: NoiseCancellationLevel;
  /**
   * Host `AudioContext` for the processing graph.
   * - Provided  → BORROWED: `stop()` does NOT close it (safe for shared contexts).
   * - Omitted   → OWNED: the tap creates one and closes it on `stop()`.
   */
  audioContext?: AudioContext;
  /** Forwarded to the processor for verbose debug logging. */
  debugMode?: boolean;
}

export interface ProcessedAudioTap {
  /** Genuine post-noise-filter `MediaStream`, ready to feed a `MediaRecorder`. */
  readonly stream: MediaStream;
  /** The processed audio track contained in {@link ProcessedAudioTap.stream}. */
  readonly track: MediaStreamTrack;
  /** Tear down the processing graph and (when owned) close the `AudioContext`. */
  stop(): Promise<void>;
}

/**
 * Create a genuine post-noise-filter audio tap from a raw microphone stream.
 *
 * @param rawStream - The unprocessed mic `MediaStream` (its first audio track is tapped).
 * @param options   - Level / AudioContext / debug options.
 * @returns A {@link ProcessedAudioTap} exposing the processed stream + a `stop()`.
 * @throws If the stream has no audio track, if RNNoise is unsupported in this
 *         browser, or if the processor fails to produce a processed track.
 */
export async function createProcessedAudioTap(rawStream: MediaStream, options: ProcessedAudioTapOptions = {}): Promise<ProcessedAudioTap> {
  const track = rawStream.getAudioTracks?.()[0];
  if (!track) {
    throw new Error('createProcessedAudioTap: raw stream has no audio track to process');
  }

  const { createNoiseFilter, getNoiseFilterBrowserSupport } = await import('@arcaai/noise-filter');

  // Gate on genuine RNNoise support BEFORE creating any resources, so an
  // unsupported browser cleanly signals the caller to fall back. (`onInit` would
  // otherwise silently pass audio through unfiltered via the native fallback.)
  const support = getNoiseFilterBrowserSupport();
  if (!support.rnnoiseSupported) {
    throw new Error(`createProcessedAudioTap: genuine RNNoise filtering unavailable (${support.unsupportedReason ?? 'unsupported browser'})`);
  }

  const ownsContext = !options.audioContext;
  const audioContext = options.audioContext ?? new AudioContext();

  const closeOwnedContext = async (): Promise<void> => {
    if (ownsContext && audioContext.state !== 'closed') {
      await audioContext.close().catch(() => {});
    }
  };

  const processor = createNoiseFilter({
    noiseCancellation: true,
    noiseCancellationLevel: options.level ?? 'high',
    debugMode: options.debugMode,
  });

  try {
    await processor.init({ track, audioContext, kind: 'audio' });
  } catch (error) {
    await closeOwnedContext();
    throw error;
  }

  const processedTrack = processor.processedTrack;
  if (!processedTrack) {
    await processor.destroy().catch(() => {});
    await closeOwnedContext();
    throw new Error('createProcessedAudioTap: noise filter did not expose a processed track');
  }

  const stream = new MediaStream([processedTrack]);
  let stopped = false;

  return {
    stream,
    track: processedTrack,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await processor.destroy().catch(() => {});
      await closeOwnedContext();
    },
  };
}
