/**
 * @arcaai/room - AudioContext Manager
 *
 * Centralized AudioContext management with browser compatibility handling.
 * Handles iOS Safari suspended state and provides shared AudioContext access.
 */

import { getAudioContextConstructor, isBrowser } from '../utils/browserSupport.js';
import { RoomError, RoomErrorCode, type RoomOptions } from '../types/index.js';

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
          `Using existing instance.`
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
   * @returns Promise that resolves when the AudioContext is ready
   */
  async acquire(): Promise<AudioContext> {
    this.referenceCount++;

    // If custom AudioContext is provided in options, use it
    if (this.options.audioContext) {
      this.audioContext = this.options.audioContext;
      await this.ensureResumed();
      return this.audioContext;
    }

    // Create new AudioContext if needed
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = this.createAudioContext();
    }

    // Ensure the context is resumed
    await this.ensureResumed();

    return this.audioContext;
  }

  /**
   * Release the AudioContext.
   * Decrements the reference count and closes the context when count reaches 0.
   */
  release(): void {
    if (this.referenceCount > 0) {
      this.referenceCount--;
    }

    // Don't close if there are still references or if it's a custom context
    if (this.referenceCount > 0 || this.options.audioContext) {
      return;
    }

    this.closeContext();
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
   */
  dispose(): void {
    this.removeClickHandler();
    this.closeContext();
    this.referenceCount = 0;
  }

  /**
   * Create a new AudioContext with optimal settings.
   */
  private createAudioContext(): AudioContext {
    const AudioContextCtor = getAudioContextConstructor();

    if (!AudioContextCtor) {
      throw new RoomError(
        RoomErrorCode.NOT_SUPPORTED,
        'AudioContext is not supported in this browser'
      );
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
   */
  private async resumeWithTimeout(timeoutMs = 500): Promise<void> {
    if (!this.audioContext) return;

    try {
      await Promise.race([
        this.audioContext.resume(),
        this.sleep(timeoutMs),
      ]);
    } catch (error) {
      console.warn('Could not resume AudioContext:', error);
      // Set up click handler as fallback
      this.setupClickHandler(this.audioContext);
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

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Get a new AudioContext with optimal settings.
 * This is a utility function for creating standalone AudioContexts.
 *
 * @param options - Optional configuration
 * @returns A new AudioContext or undefined if not supported
 */
export function getNewAudioContext(
  options?: Pick<RoomOptions, 'latencyHint' | 'sampleRate'>
): AudioContext | undefined {
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
