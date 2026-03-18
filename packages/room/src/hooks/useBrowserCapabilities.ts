/**
 * @arcaai/room - useBrowserCapabilities Hook
 *
 * React hook for accessing browser audio capabilities and limitations.
 */

import { useMemo } from 'react';
import type { BrowserCapabilities, BrowserLimitation } from '../types/index.js';
import { getBrowserCapabilities, getBrowserLimitations } from '../utils/browserCompatibility.js';

export interface UseBrowserCapabilitiesReturn {
  capabilities: BrowserCapabilities;
  limitations: BrowserLimitation[];
  isSupported: boolean;
  supportsMultipleMics: boolean;
  checkFeature: (feature: string) => boolean;
}

/**
 * Hook to access browser audio capabilities and limitations.
 * Results are memoized and computed once on mount.
 *
 * @example
 * ```tsx
 * function AudioSetup() {
 *   const { isSupported, supportsMultipleMics, limitations } = useBrowserCapabilities();
 *
 *   if (!isSupported) return <div>Browser not supported</div>;
 *
 *   return (
 *     <div>
 *       {!supportsMultipleMics && <p>Multi-mic not available</p>}
 *       {limitations.map(l => <p key={l.feature}>{l.description}</p>)}
 *     </div>
 *   );
 * }
 * ```
 */
export function useBrowserCapabilities(): UseBrowserCapabilitiesReturn {
  const capabilities = useMemo(() => getBrowserCapabilities(), []);
  const limitations = useMemo(() => getBrowserLimitations(capabilities), [capabilities]);

  const checkFeature = useMemo(() => {
    return (feature: string): boolean => {
      const featureMap: Record<string, boolean> = {
        'multiple-mics': capabilities.supportsMultipleMics,
        'audio-worklet': capabilities.supportsAudioWorklet,
        'audio-worklet-reliable': capabilities.audioWorkletReliable,
        'persistent-permissions': capabilities.supportsPersistentPermissions,
        'background-audio': capabilities.supportsBackgroundAudio,
        'shared-array-buffer': capabilities.supportsSharedArrayBuffer,
        'wasm-simd': capabilities.supportsWasmSimd,
      };
      return featureMap[feature] ?? false;
    };
  }, [capabilities]);

  return {
    capabilities,
    limitations,
    isSupported: capabilities.isSupported,
    supportsMultipleMics: capabilities.supportsMultipleMics,
    checkFeature,
  };
}
