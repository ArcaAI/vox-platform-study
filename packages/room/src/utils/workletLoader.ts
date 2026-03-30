/**
 * @arcaai/room - Shared Worklet Loader
 *
 * Generic utility for loading and registering AudioWorklet processors via blob URLs.
 * Used by @arcaai/vad and @arcaai/noise-filter to avoid duplicating the same pattern.
 */

export interface WorkletLoaderOptions {
  /** The inline source code for the worklet processor */
  generateSource: () => string;
  /** Name for error messages (e.g., 'VAD', 'RNNoise') */
  label: string;
}

export interface WorkletLoader {
  /**
   * Register the worklet with an AudioContext.
   * Subsequent calls with the same AudioContext are no-ops.
   *
   * @param audioContext - The AudioContext to register with
   * @param workletUrl - Optional external URL (uses blob URL if omitted)
   */
  register(audioContext: AudioContext, workletUrl?: string): Promise<void>;

  /** Check if the worklet has been registered for an AudioContext. */
  isRegistered(audioContext: AudioContext): boolean;

  /** Revoke the cached blob URL to free memory. */
  cleanup(): void;
}

/**
 * Create a worklet loader that manages blob URL caching and AudioContext registration.
 *
 * Both @arcaai/vad and @arcaai/noise-filter follow the same pattern:
 *   1. Generate worklet source as a string
 *   2. Create a blob URL (cached across calls)
 *   3. Track which AudioContexts have registered the worklet via WeakSet
 *
 * This factory encapsulates that pattern so each package only provides the source.
 */
export function createWorkletLoader(options: WorkletLoaderOptions): WorkletLoader {
  const { generateSource, label } = options;

  let blobUrl: string | null = null;
  const registeredContexts = new WeakSet<AudioContext>();

  function getBlobUrl(): string {
    if (!blobUrl) {
      const source = generateSource();
      const blob = new Blob([source], { type: 'application/javascript' });
      blobUrl = URL.createObjectURL(blob);
    }
    return blobUrl;
  }

  return {
    async register(audioContext: AudioContext, workletUrl?: string): Promise<void> {
      if (registeredContexts.has(audioContext)) {
        return;
      }

      if (!audioContext.audioWorklet) {
        throw new Error(`[${label}] AudioWorklet is not supported in this browser`);
      }

      const url = workletUrl ?? getBlobUrl();
      await audioContext.audioWorklet.addModule(url);
      registeredContexts.add(audioContext);
    },

    isRegistered(audioContext: AudioContext): boolean {
      return registeredContexts.has(audioContext);
    },

    cleanup(): void {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    },
  };
}
