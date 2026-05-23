/**
 * @arcaai/stt - Engine-level errors
 *
 * Typed errors surfaced by engine implementations. Currently includes
 * `STTWorkerCrashError` for `WhisperWorkerEngine` crash propagation.
 */

/**
 * Thrown when the Whisper Web Worker crashes (e.g. `worker.onerror` fires or
 * an unhandled exception escapes the worker). Pending requests at the time of
 * the crash are rejected with this error. After `STTWorkerCrashError` has
 * been thrown for `maxCrashRetries` consecutive crashes, subsequent
 * `transcribe()` calls also reject with this error until the engine is
 * `destroy()`-ed and a fresh engine is created.
 *
 * @example
 * ```ts
 * try {
 *   await engine.transcribe(audio);
 * } catch (err) {
 *   if (err instanceof STTWorkerCrashError) {
 *     console.error(`Worker crashed ${err.attempts}x`, err.cause);
 *   }
 * }
 * ```
 */
export class STTWorkerCrashError extends Error {
  public readonly name = 'STTWorkerCrashError';

  constructor(
    /** Number of restart attempts made (>= 1). */
    public readonly attempts: number,
    /** Underlying worker error event message, when available. */
    public readonly cause?: Error,
  ) {
    super(attempts > 1 ? `STT worker crashed (after ${attempts} restart attempts)` : 'STT worker crashed');
  }
}
