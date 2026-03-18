/**
 * @arcaai/room - RoomProvider
 *
 * React context provider for room-wide audio state management.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { Room, RoomEvent, RoomState } from '../core/Room.js';
import { AudioTrack } from '../core/AudioTrack.js';
import type { TrackProcessor } from '../processors/types.js';
import type { RoomOptions, AudioCaptureOptions } from '../types/index.js';

// ============================================================================
// Context Types
// ============================================================================

/**
 * Room context value provided to consumers.
 */
export interface RoomContextValue {
  /** The Room instance */
  room: Room;
  /** Current room state */
  state: RoomState;
  /** Whether the room is connected */
  isConnected: boolean;
  /** The AudioContext, if available */
  audioContext: AudioContext | null;
  /** All local audio tracks */
  localTracks: AudioTrack[];

  // Methods
  /** Connect the room */
  connect: () => Promise<void>;
  /** Disconnect the room */
  disconnect: () => Promise<void>;
  /** Create a local audio track */
  createLocalTrack: (options?: AudioCaptureOptions) => Promise<AudioTrack>;
  /** Remove a local audio track */
  removeLocalTrack: (track: AudioTrack) => Promise<void>;
  /** Resume audio (for iOS) */
  resumeAudio: () => Promise<void>;
  /** Check if audio can play */
  canPlayAudio: () => boolean;
}

// ============================================================================
// Context
// ============================================================================

const RoomContext = createContext<RoomContextValue | null>(null);

// ============================================================================
// Provider Props
// ============================================================================

/**
 * Props for RoomProvider component.
 */
export interface RoomProviderProps {
  /** Child components */
  children: ReactNode;
  /** Room configuration options */
  options?: RoomOptions;
  /** Auto-connect on mount */
  autoConnect?: boolean;
  /** Callback when room connects */
  onConnect?: () => void;
  /** Callback when room disconnects */
  onDisconnect?: () => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * RoomProvider provides room context to child components.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <RoomProvider options={{ webAudioMix: true }} autoConnect>
 *       <AudioRecorder />
 *     </RoomProvider>
 *   );
 * }
 * ```
 */
export function RoomProvider({
  children,
  options,
  autoConnect = false,
  onConnect,
  onDisconnect,
  onError,
}: RoomProviderProps) {
  // Create room instance (stable reference)
  const [room] = useState(() => new Room(options));
  const [state, setState] = useState<RoomState>(RoomState.Disconnected);
  const [localTracks, setLocalTracks] = useState<AudioTrack[]>([]);

  // Set up event listeners
  useEffect(() => {
    const handleConnected = () => {
      setState(RoomState.Connected);
      onConnect?.();
    };

    const handleDisconnected = () => {
      setState(RoomState.Disconnected);
      setLocalTracks([]);
      onDisconnect?.();
    };

    const handleTrackCreated = (track: AudioTrack) => {
      setLocalTracks((prev) => [...prev, track]);
    };

    const handleTrackRemoved = (track: AudioTrack) => {
      setLocalTracks((prev) => prev.filter((t) => t !== track));
    };

    const handleError = ({ error }: { error: Error }) => {
      setState(RoomState.Error);
      onError?.(error);
    };

    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Disconnected, handleDisconnected);
    room.on(RoomEvent.LocalTrackCreated, handleTrackCreated);
    room.on(RoomEvent.LocalTrackRemoved, handleTrackRemoved);
    room.on(RoomEvent.Error, handleError);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Disconnected, handleDisconnected);
      room.off(RoomEvent.LocalTrackCreated, handleTrackCreated);
      room.off(RoomEvent.LocalTrackRemoved, handleTrackRemoved);
      room.off(RoomEvent.Error, handleError);
    };
  }, [room, onConnect, onDisconnect, onError]);

  // Auto-connect on mount if enabled
  useEffect(() => {
    if (autoConnect) {
      room.connect().catch((error) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }

    // Cleanup on unmount
    return () => {
      room.disconnect().catch(() => {
        // Ignore disconnect errors on unmount
      });
    };
  }, [room, autoConnect, onError]);

  // Methods
  const connect = useCallback(async () => {
    await room.connect();
  }, [room]);

  const disconnect = useCallback(async () => {
    await room.disconnect();
  }, [room]);

  const createLocalTrack = useCallback(
    async (trackOptions?: AudioCaptureOptions) => {
      return room.createLocalTrack(trackOptions);
    },
    [room]
  );

  const removeLocalTrack = useCallback(
    async (track: AudioTrack) => {
      await room.removeLocalTrack(track);
    },
    [room]
  );

  const resumeAudio = useCallback(async () => {
    await room.resumeAudio();
  }, [room]);

  const canPlayAudio = useCallback(() => {
    return room.canPlayAudio();
  }, [room]);

  // Context value
  const contextValue = useMemo<RoomContextValue>(
    () => ({
      room,
      state,
      isConnected: state === RoomState.Connected,
      audioContext: room.getAudioContext(),
      localTracks,
      connect,
      disconnect,
      createLocalTrack,
      removeLocalTrack,
      resumeAudio,
      canPlayAudio,
    }),
    [
      room,
      state,
      localTracks,
      connect,
      disconnect,
      createLocalTrack,
      removeLocalTrack,
      resumeAudio,
      canPlayAudio,
    ]
  );

  return (
    <RoomContext.Provider value={contextValue}>{children}</RoomContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access room context.
 *
 * @returns Room context value
 * @throws If used outside of RoomProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isConnected, createLocalTrack } = useRoom();
 *
 *   const handleStart = async () => {
 *     const track = await createLocalTrack();
 *     console.log('Created track:', track);
 *   };
 *
 *   return (
 *     <button onClick={handleStart} disabled={!isConnected}>
 *       Start Recording
 *     </button>
 *   );
 * }
 * ```
 */
export function useRoom(): RoomContextValue {
  const context = useContext(RoomContext);

  if (!context) {
    throw new Error('useRoom must be used within a RoomProvider');
  }

  return context;
}

/**
 * Hook to safely access room context (returns null if outside provider).
 */
export function useRoomSafe(): RoomContextValue | null {
  return useContext(RoomContext);
}
