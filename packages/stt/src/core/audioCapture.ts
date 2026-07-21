/**
 * @arcaai/stt - Audio Capture
 *
 * Wires a `MediaStreamTrack` to the audio graph and emits raw mono Float32
 * frames via `onFrame`. Uses `AudioWorkletNode` when the runtime supports it;
 * falls back to the deprecated `ScriptProcessorNode` otherwise (with a
 * one-time `console.warn`).
 *
 * AudioWorklet runs off the main thread (better latency, no jank, won't be
 * removed). The `ScriptProcessorNode` fallback exists only for environments
 * where `AudioWorklet` is unavailable (very old browsers, certain test
 * doubles); MDN explicitly warns that `ScriptProcessorNode` may be removed.
 */

import { registerSTTCaptureWorklet, createSTTCaptureWorkletNode } from '../worklets/stt-capture.worklet.js';

/**
 * Default `ScriptProcessorNode` buffer size used by the fallback path.
 * Matches the value used by the legacy `STTProcessor` capture loop.
 */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

/**
 * Handle returned by {@link createAudioCapture}. `destroy()` tears down all
 * audio nodes; safe to call multiple times.
 */
export interface AudioCaptureHandle {
  /** True when capture is using `AudioWorkletNode` (preferred path). */
  readonly usesWorklet: boolean;

  /** Disconnect all nodes and free internal references. */
  destroy(): void;

  /**
   * Enable / disable frame emission without tearing down the audio graph.
   * When disabled, `onFrame` is not invoked. The audio graph itself remains
   * connected so downstream nodes (analyser, monitor) continue to receive
   * audio.
   */
  setEnabled(enabled: boolean): void;
}

/**
 * Frame callback. The provided `Float32Array` is owned by the callback for
 * the lifetime of the call only — copy if you need to retain it.
 */
export type AudioFrameCallback = (frame: Float32Array) => void;

/**
 * Options for {@link createAudioCapture}.
 */
export interface AudioCaptureOptions {
  /**
   * Coalesced frame size in ms on the worklet path. Quanta accumulate in
   * the worklet and are posted as one frame per `frameMs`,
   * cutting message rate ~10–30× vs per-quantum posting. Defaults to 80.
   * Ignored on the `ScriptProcessorNode` fallback (its 4096-sample buffer is
   * already ~85 ms at 48 kHz).
   */
  frameMs?: number;
}

/**
 * Determine whether `AudioWorklet` is usable on this `AudioContext`.
 *
 * The `navigator.audioWorklet` global check is unreliable in some test
 * environments; the per-context check is the authoritative one (`audioWorklet`
 * is a property on `BaseAudioContext`).
 */
export function isAudioWorkletUsable(audioContext: AudioContext): boolean {
  if (typeof AudioWorkletNode === 'undefined') {
    return false;
  }
  const worklet = (audioContext as AudioContext & { audioWorklet?: { addModule: (url: string) => Promise<void> } }).audioWorklet;
  return !!worklet && typeof worklet.addModule === 'function';
}

let warnedAboutScriptProcessor = false;

/**
 * Set up STT audio capture from a `MediaStreamTrack`. Returns a handle that
 * disconnects all audio nodes when `destroy()` is called.
 *
 * @param audioContext - Audio context used to create graph nodes.
 * @param track - Source track whose audio will be captured.
 * @param onFrame - Invoked with each captured Float32 frame.
 */
export async function createAudioCapture(
  audioContext: AudioContext,
  track: MediaStreamTrack,
  onFrame: AudioFrameCallback,
  options?: AudioCaptureOptions,
): Promise<AudioCaptureHandle> {
  const stream = new MediaStream([track]);
  const sourceNode = audioContext.createMediaStreamSource(stream);

  if (isAudioWorkletUsable(audioContext)) {
    return setupWorkletCapture(audioContext, sourceNode, onFrame, options);
  }

  if (!warnedAboutScriptProcessor) {
    warnedAboutScriptProcessor = true;
    console.warn(
      '[STT] AudioWorklet not available; falling back to deprecated ScriptProcessorNode. ' +
        'Audio capture will run on the main thread and may glitch under load. ' +
        'See https://developer.mozilla.org/docs/Web/API/ScriptProcessorNode',
    );
  }

  return setupScriptProcessorCapture(audioContext, sourceNode, onFrame);
}

async function setupWorkletCapture(
  audioContext: AudioContext,
  sourceNode: MediaStreamAudioSourceNode,
  onFrame: AudioFrameCallback,
  options?: AudioCaptureOptions,
): Promise<AudioCaptureHandle> {
  await registerSTTCaptureWorklet(audioContext);
  const workletNode = createSTTCaptureWorkletNode(audioContext, { frameMs: options?.frameMs });

  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const frame = event.data;
    if (frame && frame.length > 0) {
      onFrame(frame);
    }
  };

  // Mute the output sink so capture is silent in the destination but the
  // graph still pulls samples.
  const sink = audioContext.createGain();
  sink.gain.value = 0;

  sourceNode.connect(workletNode);
  workletNode.connect(sink);
  sink.connect(audioContext.destination);

  let enabled = true;
  let destroyed = false;

  return {
    usesWorklet: true,
    setEnabled(value: boolean) {
      if (destroyed || enabled === value) return;
      enabled = value;
      workletNode.port.postMessage({ type: 'setEnabled', enabled: value });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      workletNode.port.onmessage = null;
      try {
        workletNode.disconnect();
      } catch {
        /* node may already be disconnected */
      }
      try {
        sink.disconnect();
      } catch {
        /* sink may already be disconnected */
      }
      try {
        sourceNode.disconnect();
      } catch {
        /* source may already be disconnected */
      }
    },
  };
}

function setupScriptProcessorCapture(
  audioContext: AudioContext,
  sourceNode: MediaStreamAudioSourceNode,
  onFrame: AudioFrameCallback,
): AudioCaptureHandle {
  const processor = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
  const sink = audioContext.createGain();
  sink.gain.value = 0;

  let enabled = true;
  let destroyed = false;

  processor.onaudioprocess = (event) => {
    if (!enabled || destroyed) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    const frame = new Float32Array(input.length);
    frame.set(input);
    onFrame(frame);
  };

  sourceNode.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);

  return {
    usesWorklet: false,
    setEnabled(value: boolean) {
      if (destroyed) return;
      enabled = value;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        /* node may already be disconnected */
      }
      try {
        sink.disconnect();
      } catch {
        /* sink may already be disconnected */
      }
      try {
        sourceNode.disconnect();
      } catch {
        /* source may already be disconnected */
      }
    },
  };
}

/**
 * Reset the singleton warning flag — exposed for tests so each fallback test
 * can verify the warning fires.
 *
 * @internal
 */
export function __resetScriptProcessorWarning(): void {
  warnedAboutScriptProcessor = false;
}
