/**
 * @arcaai/room - Room
 *
 * Room class that manages audio context, tracks, and processors.
 * This is the main entry point for managing audio in the application.
 */

import { TypedEventEmitter } from '../events/EventEmitter.js';
import { AudioContextManager } from './AudioContextManager.js';
import { AudioMixer } from './AudioMixer.js';
import { AudioTrack, type AudioTrackOptions } from './AudioTrack.js';
import type { TrackProcessor } from '../processors/types.js';
import { type RoomOptions, type AudioCaptureOptions, DEFAULT_ROOM_OPTIONS, RoomError, RoomErrorCode } from '../types/index.js';

// ============================================================================
// Room Events
// ============================================================================

/**
 * Events emitted by Room.
 */
export enum RoomEvent {
  /** Room has been connected (AudioContext ready) */
  Connected = 'connected',
  /** Room has been disconnected */
  Disconnected = 'disconnected',
  /** Local track has been created */
  LocalTrackCreated = 'localTrackCreated',
  /** Local track has been removed */
  LocalTrackRemoved = 'localTrackRemoved',
  /** Audio playback status changed */
  AudioPlaybackStatusChanged = 'audioPlaybackStatusChanged',
  /** Error occurred */
  Error = 'error',
}

/**
 * Room event map for type-safe events.
 */
export interface RoomEventMap {
  [RoomEvent.Connected]: void;
  [RoomEvent.Disconnected]: void;
  [RoomEvent.LocalTrackCreated]: AudioTrack;
  [RoomEvent.LocalTrackRemoved]: AudioTrack;
  [RoomEvent.AudioPlaybackStatusChanged]: { canPlayback: boolean };
  [RoomEvent.Error]: { error: Error; context: string };
}

// ============================================================================
// Room State
// ============================================================================

/**
 * Room connection state.
 */
export enum RoomState {
  /** Room is not connected */
  Disconnected = 'disconnected',
  /** Room is connecting */
  Connecting = 'connecting',
  /** Room is connected */
  Connected = 'connected',
  /** Room encountered an error */
  Error = 'error',
}

// ============================================================================
// Room Class
// ============================================================================

/**
 * Room manages audio context and tracks.
 *
 * Provides:
 * - Centralized AudioContext management
 * - Local track creation and management
 * - Processor registry
 *
 * @example
 * ```typescript
 * const room = new Room({ webAudioMix: true });
 * await room.connect();
 *
 * // Create local audio track
 * const track = await room.createLocalTrack({
 *   noiseSuppression: true,
 *   echoCancellation: true,
 * });
 *
 * // Use the track
 * console.log('Track:', track.mediaStreamTrack);
 *
 * // Cleanup
 * await room.disconnect();
 * ```
 */
export class Room extends TypedEventEmitter<RoomEventMap> {
  private readonly options: RoomOptions;
  private readonly contextManager: AudioContextManager;
  private state: RoomState = RoomState.Disconnected;
  private localTracks: Map<string, AudioTrack> = new Map();
  private trackIdCounter = 0;
  private mixer: AudioMixer | null = null;

  /**
   * Create a new Room.
   *
   * @param options - Room configuration options
   */
  constructor(options: RoomOptions = {}) {
    super();
    this.options = { ...DEFAULT_ROOM_OPTIONS, ...options };
    this.contextManager = AudioContextManager.getInstance(this.options);
  }

  /**
   * Get the current room state.
   */
  getState(): RoomState {
    return this.state;
  }

  /**
   * Check if the room is connected.
   */
  isConnected(): boolean {
    return this.state === RoomState.Connected;
  }

  /**
   * Get the AudioContext.
   */
  getAudioContext(): AudioContext | null {
    return this.contextManager.getContext();
  }

  /**
   * Connect the room (initialize AudioContext).
   */
  async connect(): Promise<void> {
    if (this.state === RoomState.Connected) {
      return;
    }

    this.state = RoomState.Connecting;

    try {
      await this.contextManager.acquire();
      this.state = RoomState.Connected;

      if (this.options.webAudioMix) {
        const ctx = this.contextManager.getContext();
        if (ctx) {
          this.mixer = new AudioMixer(ctx);
        }
      }

      this.emit(RoomEvent.Connected);
    } catch (error) {
      this.state = RoomState.Error;
      this.emit(RoomEvent.Error, {
        error: error instanceof Error ? error : new Error(String(error)),
        context: 'connect',
      });
      throw error;
    }
  }

  /**
   * Disconnect the room and release resources.
   */
  async disconnect(): Promise<void> {
    // Stop all local tracks
    for (const track of this.localTracks.values()) {
      await track.stop();
    }
    this.localTracks.clear();

    // Dispose mixer
    if (this.mixer) {
      this.mixer.dispose();
      this.mixer = null;
    }

    // Release AudioContext
    this.contextManager.release();

    this.state = RoomState.Disconnected;
    this.emit(RoomEvent.Disconnected);
  }

  /**
   * Create a local audio track from the microphone.
   *
   * @param options - Audio capture options
   * @returns The created AudioTrack
   */
  async createLocalTrack(options?: AudioCaptureOptions): Promise<AudioTrack> {
    if (!this.isConnected()) {
      await this.connect();
    }

    const audioContext = this.getAudioContext();
    if (!audioContext) {
      throw new RoomError(RoomErrorCode.AUDIO_CONTEXT_SUSPENDED, 'AudioContext not available');
    }

    const trackOptions: AudioTrackOptions = {
      ...options,
      audioContext,
    };

    const track = new AudioTrack(trackOptions);
    await track.initialize(options);

    // Store the track
    const trackId = this.generateTrackId();
    this.localTracks.set(trackId, track);

    this.emit(RoomEvent.LocalTrackCreated, track);

    return track;
  }

  /**
   * Create a local audio track from an existing MediaStreamTrack.
   *
   * @param mediaTrack - The MediaStreamTrack to use
   * @returns The created AudioTrack
   */
  async createLocalTrackFromMediaStreamTrack(mediaTrack: MediaStreamTrack): Promise<AudioTrack> {
    if (!this.isConnected()) {
      await this.connect();
    }

    const audioContext = this.getAudioContext();
    if (!audioContext) {
      throw new RoomError(RoomErrorCode.AUDIO_CONTEXT_SUSPENDED, 'AudioContext not available');
    }

    const track = new AudioTrack({ audioContext });
    await track.initializeFromTrack(mediaTrack);

    // Store the track
    const trackId = this.generateTrackId();
    this.localTracks.set(trackId, track);

    this.emit(RoomEvent.LocalTrackCreated, track);

    return track;
  }

  /**
   * Remove a local track.
   *
   * @param track - The track to remove
   */
  async removeLocalTrack(track: AudioTrack): Promise<void> {
    // Find the track ID
    let foundId: string | null = null;
    for (const [id, t] of this.localTracks) {
      if (t === track) {
        foundId = id;
        break;
      }
    }

    if (!foundId) {
      return;
    }

    await track.stop();
    this.localTracks.delete(foundId);

    this.emit(RoomEvent.LocalTrackRemoved, track);
  }

  /**
   * Get all local tracks.
   */
  getLocalTracks(): AudioTrack[] {
    return Array.from(this.localTracks.values());
  }

  /**
   * Resume audio playback (useful for iOS).
   */
  async resumeAudio(): Promise<void> {
    await this.contextManager.resume();

    const canPlayback = this.contextManager.isReady();
    this.emit(RoomEvent.AudioPlaybackStatusChanged, { canPlayback });
  }

  /**
   * Check if audio can play.
   */
  canPlayAudio(): boolean {
    return this.contextManager.isReady();
  }

  /**
   * Get the AudioMixer instance (available when webAudioMix is true).
   */
  getMixer(): AudioMixer | null {
    return this.mixer;
  }

  /**
   * Get the sample rate.
   */
  getSampleRate(): number | undefined {
    return this.contextManager.getSampleRate();
  }

  /**
   * Generate a unique track ID.
   */
  private generateTrackId(): string {
    return `track-${++this.trackIdCounter}`;
  }
}

/**
 * Create local audio tracks without a Room.
 * Utility function for simple use cases.
 *
 * @param options - Audio capture options
 * @returns Array of AudioTracks
 */
export async function createLocalTracks(options?: AudioCaptureOptions & { processor?: TrackProcessor }): Promise<AudioTrack[]> {
  const track = new AudioTrack();
  await track.initialize(options);

  if (options?.processor) {
    // Need AudioContext for processors
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    track.setAudioContext(ctx);
    await track.setProcessor(options.processor);
  }

  return [track];
}
