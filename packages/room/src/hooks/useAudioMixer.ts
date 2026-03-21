/**
 * @arcaai/room - useAudioMixer Hook
 *
 * React hook for multi-source audio mixing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioMixer } from '../core/AudioMixer.js';
import { AudioContextManager } from '../core/AudioContextManager.js';

export interface UseAudioMixerReturn {
  mixer: AudioMixer | null;
  mixedTrack: MediaStreamTrack | null;
  sourceCount: number;
  addSource: (id: string, stream: MediaStream, gain?: number) => void;
  removeSource: (id: string) => void;
  setGain: (id: string, gain: number) => void;
  muteSource: (id: string, muted: boolean) => void;
  dispose: () => void;
}

/**
 * Hook for multi-source audio mixing using Web Audio API.
 *
 * Creates an AudioMixer instance using the shared AudioContextManager.
 * Automatically disposes on unmount.
 *
 * @example
 * ```tsx
 * function MixerPanel() {
 *   const { addSource, removeSource, mixedTrack, sourceCount } = useAudioMixer();
 *
 *   const handleAddMic = async (deviceId: string) => {
 *     const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
 *     addSource(deviceId, stream);
 *   };
 *
 *   return <div>Sources: {sourceCount}</div>;
 * }
 * ```
 */
export function useAudioMixer(): UseAudioMixerReturn {
  const mixerRef = useRef<AudioMixer | null>(null);
  const [sourceCount, setSourceCount] = useState(0);
  const [mixedTrack, setMixedTrack] = useState<MediaStreamTrack | null>(null);

  const ensureMixer = useCallback((): AudioMixer => {
    if (!mixerRef.current || mixerRef.current.isDisposed()) {
      const ctxManager = AudioContextManager.getInstance({ sampleRate: 48000 });
      const ctx = ctxManager.getContext();
      if (!ctx) {
        throw new Error('AudioContext not available. Call AudioContextManager.acquire() first.');
      }
      mixerRef.current = new AudioMixer(ctx);
      mixerRef.current.on('mixChanged', ({ sourceCount: count }) => {
        setSourceCount(count);
        setMixedTrack(mixerRef.current?.getMixedTrack() ?? null);
      });
      mixerRef.current.on('disposed', () => {
        setSourceCount(0);
        setMixedTrack(null);
      });
    }
    return mixerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      if (mixerRef.current && !mixerRef.current.isDisposed()) {
        mixerRef.current.dispose();
        mixerRef.current = null;
      }
    };
  }, []);

  const addSource = useCallback((id: string, stream: MediaStream, gain?: number) => {
    const mixer = ensureMixer();
    mixer.addSource(id, stream, gain);
  }, [ensureMixer]);

  const removeSource = useCallback((id: string) => {
    mixerRef.current?.removeSource(id);
  }, []);

  const setGain = useCallback((id: string, gain: number) => {
    mixerRef.current?.setSourceGain(id, gain);
  }, []);

  const muteSource = useCallback((id: string, muted: boolean) => {
    mixerRef.current?.muteSource(id, muted);
  }, []);

  const dispose = useCallback(() => {
    if (mixerRef.current && !mixerRef.current.isDisposed()) {
      mixerRef.current.dispose();
      mixerRef.current = null;
    }
  }, []);

  return {
    mixer: mixerRef.current,
    mixedTrack,
    sourceCount,
    addSource,
    removeSource,
    setGain,
    muteSource,
    dispose,
  };
}
