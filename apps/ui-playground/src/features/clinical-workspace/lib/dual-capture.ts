/**
 * Dual audio capture (TASK-330 P3, WS3).
 *
 * Captures TWO artifacts from a single consultation:
 *   - RAW: the microphone `MediaStream` exactly as `getUserMedia` returned it,
 *     before any processing (the realtime hook feeds PCM straight to STT, so its
 *     `inputStream` IS the raw, pre-noise-filter tap the contract asks for).
 *   - PROCESSED: the GENUINE post-noise-filter output. When a `processedTapFactory`
 *     is supplied (the SDK's `createProcessedAudioTap`, backed by the same RNNoise
 *     `NoiseFilterProcessor` the transcription pipeline uses), the processed blob
 *     is the real post-DSP PCM. If that tap is unavailable at runtime (RNNoise
 *     unsupported / init failure), it falls back to a light WebAudio approximation
 *     (high-pass + gain) — clearly flagged via `DualCaptureResult.processedSource`.
 *
 * Both blobs are uploaded to storage and registered via
 * `POST /consultations/:id/recordings { mediaId, rawMediaId, processedMediaId }`.
 *
 * The pure helpers (`pickRecorderMimeType`, `buildDualRecordingInput`) are
 * unit-tested; `DualStreamRecorder` is DOM-bound and exercised with fakes.
 */
import type { AddAudioRecordingRequest } from '../types';

/** Raw-capture mic constraints — all browser DSP disabled so we keep the true signal. */
export const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** Preferred container/codecs for the captured blobs, best first. */
export const DUAL_CAPTURE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;

/**
 * Pick the first MIME type the platform's `MediaRecorder` supports. Returns `''`
 * (let the browser choose) when none match or `MediaRecorder` is unavailable.
 */
export function pickRecorderMimeType(candidates: readonly string[] = DUAL_CAPTURE_MIME_CANDIDATES): string {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const candidate of candidates) {
    if (MR.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export interface BuildDualRecordingInput {
  /** Storage key of the processed (canonical) artifact. */
  processedMediaId: string;
  /** Storage key of the raw mic artifact. */
  rawMediaId: string;
  durationMs?: number;
  language?: string;
}

/**
 * Build the `POST /consultations/:id/recordings` body. The processed artifact is
 * the canonical `mediaId`; raw + processed ids are carried alongside so the
 * consultation records the dual-capture pair.
 */
export function buildDualRecordingInput(input: BuildDualRecordingInput): AddAudioRecordingRequest {
  return {
    mediaId: input.processedMediaId,
    rawMediaId: input.rawMediaId,
    processedMediaId: input.processedMediaId,
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(input.language ? { language: input.language } : {}),
  };
}

/** Where the processed artifact came from. */
export type ProcessedAudioSource = 'noise-filter' | 'approximation';

/**
 * Minimal structural shape of a genuine processed-audio tap (the SDK's
 * `createProcessedAudioTap` return). Kept local so this lib stays decoupled from
 * the `@arcaai/vox` runtime (the hook injects the real factory).
 */
export interface ProcessedAudioTapLike {
  /** The genuine post-noise-filter stream to record. */
  stream: MediaStream;
  /** Tear down the tap's processing graph (never stops the shared mic track). */
  stop: () => Promise<void> | void;
}

/** Async factory that produces a genuine processed-audio tap from the raw mic stream. */
export type ProcessedAudioTapFactory = (rawStream: MediaStream) => Promise<ProcessedAudioTapLike>;

export interface DualCaptureResult {
  raw: Blob;
  processed: Blob;
  mimeType: string;
  durationMs: number;
  /** `'noise-filter'` = genuine post-DSP PCM; `'approximation'` = WebAudio fallback. */
  processedSource: ProcessedAudioSource;
}

interface RecorderHandle {
  recorder: MediaRecorder;
  chunks: Blob[];
}

function startRecorder(stream: MediaStream, mimeType: string): RecorderHandle {
  const chunks: Blob[] = [];
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();
  return { recorder, chunks };
}

function stopRecorder(handle: RecorderHandle, mimeType: string): Promise<Blob> {
  return new Promise((resolve) => {
    const finalize = () => resolve(new Blob(handle.chunks, { type: handle.recorder.mimeType || mimeType || 'audio/webm' }));
    handle.recorder.onstop = finalize;
    if (handle.recorder.state !== 'inactive') handle.recorder.stop();
    else finalize();
  });
}

/**
 * Records the raw mic stream and a processed copy in parallel. Construct with
 * the live session's input `MediaStream`, then `start()` / `stop()`.
 *
 * The processed lane prefers the GENUINE post-noise-filter tap (`processedTapFactory`,
 * the SDK's `createProcessedAudioTap`); if that tap is unavailable at runtime it
 * falls back to a WebAudio approximation. The raw recorder starts synchronously
 * (so construction errors surface to the caller as before); the genuine tap is
 * created asynchronously, and `stop()` awaits that startup before flushing.
 */
export class DualStreamRecorder {
  private readonly inputStream: MediaStream;
  private readonly mimeType: string;
  private readonly audioContextFactory: () => AudioContext;
  private readonly processedTapFactory?: ProcessedAudioTapFactory;
  private rawHandle: RecorderHandle | null = null;
  private processedHandle: RecorderHandle | null = null;
  private audioContext: AudioContext | null = null;
  private processedDestination: MediaStreamAudioDestinationNode | null = null;
  private processedTap: ProcessedAudioTapLike | null = null;
  private processedSource: ProcessedAudioSource = 'approximation';
  private startProcessedPromise: Promise<void> | null = null;
  private startedAt = 0;

  constructor(
    inputStream: MediaStream,
    options: { mimeType?: string; audioContextFactory?: () => AudioContext; processedTapFactory?: ProcessedAudioTapFactory } = {},
  ) {
    this.inputStream = inputStream;
    this.mimeType = options.mimeType ?? pickRecorderMimeType();
    this.audioContextFactory = options.audioContextFactory ?? (() => new AudioContext());
    this.processedTapFactory = options.processedTapFactory;
  }

  get isRecording(): boolean {
    return this.rawHandle !== null;
  }

  start(): void {
    if (this.rawHandle) return;
    // RAW — straight off the mic input. Synchronous so MediaRecorder construction
    // errors propagate to the caller exactly as before.
    this.rawHandle = startRecorder(this.inputStream, this.mimeType);
    this.startedAt = Date.now();

    // PROCESSED — prefer the genuine tap; fall back to the approximation. The tap
    // is async, so kick it off and let stop() await it.
    this.startProcessedPromise = this.startProcessed();
    this.startProcessedPromise.catch(() => {});
  }

  private async startProcessed(): Promise<void> {
    if (this.processedTapFactory) {
      try {
        const tap = await this.processedTapFactory(this.inputStream);
        this.processedTap = tap;
        this.processedSource = 'noise-filter';
        this.processedHandle = startRecorder(tap.stream, this.mimeType);
        return;
      } catch {
        // Genuine tap unavailable at runtime — fall back to the approximation.
      }
    }
    this.startApproximation();
    this.processedSource = 'approximation';
  }

  /** Light WebAudio cleanup graph (high-pass + gain) rendered to its own stream. */
  private startApproximation(): void {
    this.audioContext = this.audioContextFactory();
    const source = this.audioContext.createMediaStreamSource(this.inputStream);
    const highpass = this.audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85; // trim sub-bass rumble
    const gain = this.audioContext.createGain();
    gain.gain.value = 1.05;
    this.processedDestination = this.audioContext.createMediaStreamDestination();
    source.connect(highpass);
    highpass.connect(gain);
    gain.connect(this.processedDestination);
    this.processedHandle = startRecorder(this.processedDestination.stream, this.mimeType);
  }

  async stop(): Promise<DualCaptureResult | null> {
    if (this.startProcessedPromise) {
      await this.startProcessedPromise.catch(() => {});
      this.startProcessedPromise = null;
    }
    if (!this.rawHandle) return null;

    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const [raw, processed] = await Promise.all([
      stopRecorder(this.rawHandle, this.mimeType),
      this.processedHandle
        ? stopRecorder(this.processedHandle, this.mimeType)
        : Promise.resolve(new Blob([], { type: this.mimeType || 'audio/webm' })),
    ]);

    // Tear down the processing resources we own. The raw mic track is shared
    // (owned by the caller) and is intentionally left running.
    if (this.processedTap) {
      await Promise.resolve(this.processedTap.stop()).catch(() => {});
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }

    const processedSource = this.processedSource;
    this.rawHandle = null;
    this.processedHandle = null;
    this.audioContext = null;
    this.processedDestination = null;
    this.processedTap = null;

    return { raw, processed, mimeType: this.mimeType || raw.type || 'audio/webm', durationMs, processedSource };
  }
}
