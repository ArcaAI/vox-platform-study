/**
 * @arcaai/room - AudioTrackRenderer
 *
 * Component for rendering an audio track to an audio element.
 */

import React, { useEffect, useRef } from 'react';
import type { AudioTrack } from '../core/AudioTrack.js';

/**
 * Props for AudioTrackRenderer component.
 */
export interface AudioTrackRendererProps {
  /** The AudioTrack to render */
  track: AudioTrack | null;
  /** Whether to autoplay the audio */
  autoPlay?: boolean;
  /** Whether to mute the audio element (for preventing feedback) */
  muted?: boolean;
  /** Volume (0-1) */
  volume?: number;
  /** Additional props for the audio element */
  audioProps?: React.AudioHTMLAttributes<HTMLAudioElement>;
}

/**
 * Component that renders an AudioTrack to an audio element.
 *
 * This is useful for playing back captured audio or for
 * creating audio monitors.
 *
 * @example
 * ```tsx
 * function AudioMonitor() {
 *   const { track } = useAudioTrack({ autoStart: true });
 *
 *   return (
 *     <AudioTrackRenderer
 *       track={track}
 *       muted={true} // Mute to prevent feedback
 *       volume={0}
 *     />
 *   );
 * }
 * ```
 */
export function AudioTrackRenderer({ track, autoPlay = true, muted = true, volume = 0, audioProps }: AudioTrackRendererProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) return;

    const mediaStreamTrack = track?.mediaStreamTrack;

    if (mediaStreamTrack) {
      const stream = new MediaStream([mediaStreamTrack]);
      audioElement.srcObject = stream;

      if (autoPlay) {
        audioElement.play().catch((error) => {
          console.warn('Audio autoplay failed:', error);
        });
      }
    } else {
      audioElement.srcObject = null;
    }

    return () => {
      audioElement.srcObject = null;
    };
  }, [track, track?.mediaStreamTrack, autoPlay]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (audioElement) {
      audioElement.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  return <audio ref={audioRef} autoPlay={autoPlay} muted={muted} playsInline {...audioProps} style={{ display: 'none', ...audioProps?.style }} />;
}
