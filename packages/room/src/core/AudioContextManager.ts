/**
 * @arcaai/room - AudioContext Manager
 *
 * Centralized AudioContext management with browser compatibility handling.
 * Handles iOS Safari suspended state and provides shared AudioContext access.
 */

import { getAudioContextConstructor, isBrowser } from '../utils/browserSupport.js';
import { RoomError, RoomErrorCode, type RoomOptions } from '../types/index.js';
import { RoomResumeTimeoutError, RoomSampleRateMismatchError } from './RoomErrors.js';

/**
 * TASK-300 L-1: optional sample-rate enforcement for {@link AudioContextManager.acquire}.
 *
 * Downstream processors hard-code the audio sample rate they were designed
 * for (RNNoise → 48 000 Hz; Silero VAD → 16 000 Hz with internal resampling).
 * If the host AudioContext runs at a different rate, those processors
 * silently degrade in quality. Use these options to opt into a strict
 * (throw) or warn-only enforcement at acquire-time.
 *
 * - `requireSampleRate` — when set, `acquire()` will compare the context's
 *   `sampleRate` against this value.
 * - `allowMismatch` (default `false`) — when `true`, a mismatch logs
 *   `console.warn` instead of throwing.
 * - `tenantId` — TASK-317 W5.2 (AC-15): optional caller identity used purely to
 *   emit a dev-mode warning when the process-wide singleton is acquired
 *   concurrently by a different tenant (see {@link AudioContextManager.acquire}).
 *   It has no effect on the context lifecycle and is safe to omit.
 */
export interface AudioContextAcquireOptions {
  requireSampleRate?: number;
  allowMismatch?: boolean;
  tenantId?: string;
}

/**
 * Default timeout (in milliseconds) for {@link AudioContextManager.resume}
 * before throwing {@link RoomResumeTimeoutError}. Empirically, iOS Safari
 * resolves `resume()` within ~50ms after a user gesture; 3s gives ample
 * headroom while still surfacing a stuck state to callers.
 */
const DEFAULT_RESUME_TIMEOUT_MS = 3000;

/**
 * Singleton manager for AudioContext.
 *
 * Provides centralized AudioContext management with:
 * - Automatic handling of iOS Safari suspended state
 * - Shared AudioContext across the application
 * - Proper cleanup and lifecycle management
 *
 * @example
 * ```typescript
 * const manager = AudioContextManager.getInstance();
 * await manager.acquire();
 *
 * const ctx = manager.getContext();
 * // Use ctx for audio processing
 *
 * manager.release();
 * ```
 */
export class AudioContextManager {
  private static instance: AudioContextManager | null = null;

  private audioContext: AudioContext | null = null;
  private referenceCount = 0;
  private resumePromise: Promise<void> | null = null;
  private clickHandler: (() => void) | null = null;

  /**
   * Tracks whether a deferred close is in flight. Set by {@link release}
   * when the reference count reaches zero, and cleared by either a fresh
   * {@link acquire} (cancels the pending close — the StrictMode case) or by
   * the deferred microtask itself when it executes the close.
   */
  private pendingClose = false;

  /**
   * TASK-317 W5.2 (AC-15): tenant ids of the current holders, tracked solely to
   * power the dev-mode cross-tenant warning in {@link acquire}. Cleared whenever
   * the reference count returns to zero (no holders). Has no bearing on the
   * AudioContext lifecycle.
   */
  private readonly acquiredTenantIds = new Set<string>();

  private readonly options: RoomOptions;
  private creationOptions: { sampleRate?: number; latencyHint?: AudioContextLatencyCategory } | null = null;

  /**
   * Private constructor - use getInstance() instead.
   */
  private constructor(options: RoomOptions = {}) {
    this.options = options;
    this.creationOptions = {
      sampleRate: options.sampleRate,
      latencyHint: options.latencyHint,
    };
  }

  /**
   * Get the singleton instance of AudioContextManager.
   *
   * @param options - Optional configuration options
   * @returns The AudioContextManager instance
   */
  static getInstance(options?: RoomOptions): AudioContextManager {
    if (!AudioContextManager.instance) {
      AudioContextManager.instance = new AudioContextManager(options);
    } else if (options && AudioContextManager.instance.creationOptions) {
      const existing = AudioContextManager.instance.creationOptions;
      if (
        (options.sampleRate !== undefined && options.sampleRate !== existing.sampleRate) ||
        (options.latencyHint !== undefined && options.latencyHint !== existing.latencyHint)
      ) {
        console.warn(
          `[AudioContextManager] getInstance called with different options. ` +
            `Existing: sampleRate=${existing.sampleRate}, latencyHint=${existing.latencyHint}. ` +
            `Requested: sampleRate=${options.sampleRate}, latencyHint=${options.latencyHint}. ` +
            `Using existing instance.`,
        );
      }
    }
    return AudioContextManager.instance;
  }

  /**
   * Reset the singleton instance (useful for testing).
   */
  static resetInstance(): void {
    if (AudioContextManager.instance) {
      AudioContextManager.instance.dispose();
      AudioContextManager.instance = null;
    }
  }

  /**
   * Acquire the AudioContext.
   * Creates a new context if one doesn't exist, or resumes a suspended one.
   * Increments the reference count.
   *
   * If a deferred close from a prior {@link release} is still pending in the
   * microtask queue, it is cancelled here — this is what makes the manager
   * tolerant of React 19 StrictMode dev double-mount, where the cleanup phase
   * (release) and re-mount phase (acquire) run within the same synchronous
   * task.
   *
   * @returns Promise that resolves when the AudioContext is ready
   */
  async acquire(opts: AudioContextAcquireOptions = {}): Promise<AudioContext> {
    // Cancel any pending deferred close — keeps the existing context alive
    // across StrictMode mount → cleanup → re-mount cycles.
    this.pendingClose = false;
    this.referenceCount++;

    // TASK-317 W5.2 (AC-15): surface concurrent cross-tenant use of the
    // process-wide singleton in development (warning only — no behaviour change).
    this.warnOnCrossTenantAcquire(opts.tenantId);

    // If custom AudioContext is provided in options, use it
    if (this.options.audioContext) {
      this.audioContext = this.options.audioContext;
      await this.ensureResumed();
      this.enforceSampleRate(this.audioContext, opts);
      return this.audioContext;
    }

    // Create new AudioContext if needed
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = this.createAudioContext();
    }

    // Ensure the context is resumed
    await this.ensureResumed();

    this.enforceSampleRate(this.audioContext, opts);
    return this.audioContext;
  }

  /**
   * TASK-300 L-1: validate the active context's `sampleRate` against the
   * caller's requirement.
   *
   * - No-op when {@link AudioContextAcquireOptions.requireSampleRate} is
   *   unset (preserves backwards compatibility).
   * - Throws {@link RoomSampleRateMismatchError} on mismatch by default.
   * - When `allowMismatch: true`, logs `console.warn` instead and resolves.
   */
  private enforceSampleRate(ctx: AudioContext, opts: AudioContextAcquireOptions): void {
    if (opts.requireSampleRate === undefined) return;
    if (ctx.sampleRate === opts.requireSampleRate) return;

    const message =
      `AudioContext sampleRate is ${ctx.sampleRate} Hz but the caller required ` +
      `${opts.requireSampleRate} Hz. Downstream processors (e.g. @arcaai/noise-filter) ` +
      `assume a fixed rate and will produce audible artefacts otherwise.`;

    if (opts.allowMismatch) {
      console.warn(`[AudioContextManager] ${message}`);
      return;
    }

    throw new RoomSampleRateMismatchError(message);
  }

  /**
   * TASK-317 W5.2 (AC-15 / audit D-6): emit a development-only warning when the
   * shared, process-wide AudioContext is acquired by a tenant while it is still
   * held by a *different* tenant.
   *
   * The singleton is structurally correct (browsers cap the number of
   * AudioContexts), but combined with concurrent `AgenticProvider`s it means
   * audio frames flow through a context conceptually owned by "whichever tenant
   * last acquired it". This warning makes that multi-tenant smell visible during
   * development without changing any lifecycle behaviour.
   *
   * Dev-guard matches the SDK convention (`process.env.NODE_ENV !== 'production'`,
   * tolerant of an undefined `process`). Callers that omit `tenantId` are not
   * tracked (no warning) so existing callers are unaffected.
   */
  private warnOnCrossTenantAcquire(tenantId?: string): void {
    const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    if (nodeEnv === 'production') return;

    if (!tenantId) return;

    // referenceCount already includes the current acquire() at this point, so
    // `> 1` means at least one other reference is live.
    const heldByDifferentTenant = this.referenceCount > 1 && [...this.acquiredTenantIds].some((id) => id !== tenantId);

    if (heldByDifferentTenant) {
      console.warn(
        `[AudioContextManager] acquire() called by tenant "${tenantId}" while the ` +
          `process-wide AudioContext is still held by a different tenant ` +
          `(${[...this.acquiredTenantIds].join(', ')}). The AudioContext is a single ` +
          `shared instance; concurrent multi-tenant use in one tab can cross audio ` +
          `paths and trigger teardown for the wrong tenant. Use one AgenticProvider ` +
          `per tab, or fully release the prior tenant's context first.`,
      );
    }

    this.acquiredTenantIds.add(tenantId);
  }

  /**
   * Release the AudioContext.
   *
   * Decrements the reference count. When the count reaches zero, the close
   * is **deferred** to the next microtask via {@link queueMicrotask}. This
   * grace window allows React 19 StrictMode to call cleanup (release)
   * followed immediately by re-mount (acquire) without losing the underlying
   * `AudioContext`. If a synchronous {@link acquire} arrives before the
   * microtask runs, it cancels the pending close (sets `pendingClose=false`
   * and bumps the reference count back up), and the close is skipped.
   *
   * Custom (caller-supplied) contexts are never closed — the caller owns
   * them.
   */
  release(): void {
    if (this.referenceCount > 0) {
      this.referenceCount--;
    }

    // TASK-317 W5.2 (AC-15): no holders left → forget tracked tenants so the
    // next acquire() starts a fresh cross-tenant warning window.
    if (this.referenceCount === 0) {
      this.acquiredTenantIds.clear();
    }

    // Don't close if there are still references or if it's a custom context.
    if (this.referenceCount > 0 || this.options.audioContext) {
      return;
    }

    // Schedule a deferred close. A subsequent acquire() within the same
    // synchronous task will set pendingClose = false (and ref count back to >0)
    // so this microtask becomes a no-op — the StrictMode safety guard.
    this.pendingClose = true;
    queueMicrotask(() => {
      if (!this.pendingClose) return;
      if (this.referenceCount > 0) return;
      this.pendingClose = false;
      this.closeContext();
    });
  }

  /**
   * Get the current AudioContext, if available.
   *
   * @returns The AudioContext or null if not initialized
   */
  getContext(): AudioContext | null {
    return this.audioContext;
  }

  /**
   * Get the current state of the AudioContext.
   */
  getState(): AudioContextState | 'uninitialized' {
    return this.audioContext?.state ?? 'uninitialized';
  }

  /**
   * Check if the AudioContext is ready for use.
   */
  isReady(): boolean {
    return this.audioContext?.state === 'running';
  }

  /**
   * Get the sample rate of the AudioContext.
   */
  getSampleRate(): number | undefined {
    return this.audioContext?.sampleRate;
  }

  /**
   * Resume the AudioContext if suspended.
   */
  async resume(): Promise<void> {
    await this.ensureResumed();
  }

  /**
   * Suspend the AudioContext.
   */
  async suspend(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'running') {
      await this.audioContext.suspend();
    }
  }

  /**
   * Dispose of the AudioContextManager and close the AudioContext.
   *
   * Cancels any deferred close from {@link release} and forces an immediate
   * close. This is the hard-reset path used by tests and `resetInstance`.
   */
  dispose(): void {
    this.pendingClose = false;
    this.removeClickHandler();
    this.closeContext();
    this.referenceCount = 0;
    this.acquiredTenantIds.clear();
  }

  /**
   * Create a new AudioContext with optimal settings.
   */
  private createAudioContext(): AudioContext {
    const AudioContextCtor = getAudioContextConstructor();

    if (!AudioContextCtor) {
      throw new RoomError(RoomErrorCode.NOT_SUPPORTED, 'AudioContext is not supported in this browser');
    }

    const options: AudioContextOptions = {
      latencyHint: this.options.latencyHint ?? 'interactive',
    };

    if (this.options.sampleRate) {
      options.sampleRate = this.options.sampleRate;
    }

    const ctx = new AudioContextCtor(options);

    // Set up click handler for iOS Safari suspended state
    if (ctx.state === 'suspended') {
      this.setupClickHandler(ctx);
    }

    return ctx;
  }

  /**
   * Ensure the AudioContext is resumed.
   */
  private async ensureResumed(): Promise<void> {
    if (!this.audioContext) {
      return;
    }

    if (this.audioContext.state === 'running') {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      // If there's already a resume in progress, wait for it
      if (this.resumePromise) {
        await this.resumePromise;
        return;
      }

      // Try to resume with a timeout
      this.resumePromise = this.resumeWithTimeout();

      try {
        await this.resumePromise;
      } finally {
        this.resumePromise = null;
      }
    }
  }

  /**
   * Resume the AudioContext with a timeout.
   *
   * Races `audioContext.resume()` against a {@link setTimeout}-driven
   * rejection. If the timeout wins, throws {@link RoomResumeTimeoutError}
   * and attaches a fallback click/touchstart/keydown handler so the next
   * user gesture can still recover the context (iOS Safari pattern).
   *
   * Distinct from the previous implementation, the timeout branch now
   * surfaces an error to the caller instead of silently treating it as a
   * successful resume.
   */
  private async resumeWithTimeout(timeoutMs = DEFAULT_RESUME_TIMEOUT_MS): Promise<void> {
    if (!this.audioContext) return;

    const ctx = this.audioContext;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new RoomResumeTimeoutError(`AudioContext.resume() timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([ctx.resume(), timeoutPromise]);
    } catch (error) {
      // Whether the failure was the timeout or a resume() rejection, if the
      // context is still not running, attach the click-handler fallback so
      // the next user gesture can recover.
      if (ctx.state !== 'running') {
        this.setupClickHandler(ctx);
      }
      throw error;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }

    // Defensive: if resume() resolved without transitioning to 'running'
    // (some browsers report state changes asynchronously), still attach the
    // click handler so a subsequent gesture can finish the job.
    if (ctx.state !== 'running') {
      this.setupClickHandler(ctx);
    }
  }

  /**
   * Set up a click handler to resume the AudioContext on user interaction.
   * This is required for iOS Safari which suspends AudioContext by default.
   */
  private setupClickHandler(ctx: AudioContext): void {
    if (!isBrowser() || this.clickHandler) return;

    this.clickHandler = async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
      } finally {
        this.removeClickHandler();
      }
    };

    // Add listeners for various user interactions
    document.body?.addEventListener('click', this.clickHandler, { once: true });
    document.body?.addEventListener('touchstart', this.clickHandler, { once: true });
    document.body?.addEventListener('keydown', this.clickHandler, { once: true });
  }

  /**
   * Remove the click handler.
   */
  private removeClickHandler(): void {
    if (!isBrowser() || !this.clickHandler) return;

    document.body?.removeEventListener('click', this.clickHandler);
    document.body?.removeEventListener('touchstart', this.clickHandler);
    document.body?.removeEventListener('keydown', this.clickHandler);
    this.clickHandler = null;
  }

  /**
   * Close the AudioContext.
   */
  private closeContext(): void {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close().catch(() => {
          // Ignore close errors
        });
      } catch {
        // Ignore close errors
      }
    }
    this.audioContext = null;
  }
}

/**
 * Get a new AudioContext with optimal settings.
 * This is a utility function for creating standalone AudioContexts.
 *
 * @param options - Optional configuration
 * @returns A new AudioContext or undefined if not supported
 */
export function getNewAudioContext(options?: Pick<RoomOptions, 'latencyHint' | 'sampleRate'>): AudioContext | undefined {
  const AudioContextCtor = getAudioContextConstructor();

  if (!AudioContextCtor) {
    return undefined;
  }

  const ctxOptions: AudioContextOptions = {
    latencyHint: options?.latencyHint ?? 'interactive',
  };

  if (options?.sampleRate) {
    ctxOptions.sampleRate = options.sampleRate;
  }

  const audioContext = new AudioContextCtor(ctxOptions);

  // Handle suspended state with click listener
  if (audioContext.state === 'suspended' && isBrowser() && document.body) {
    const handleResume = async () => {
      try {
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
      } finally {
        document.body?.removeEventListener('click', handleResume);
        document.body?.removeEventListener('touchstart', handleResume);
      }
    };

    document.body.addEventListener('click', handleResume, { once: true });
    document.body.addEventListener('touchstart', handleResume, { once: true });
  }

  return audioContext;
}
