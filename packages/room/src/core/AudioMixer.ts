/**
 * @arcaai/room - AudioMixer
 *
 * Multi-source audio mixer using Web Audio API GainNode summation.
 * Combines multiple MediaStream inputs into a single mixed output.
 */

import { TypedEventEmitter } from '../events/EventEmitter.js';

export interface AudioMixerSource {
  id: string;
  stream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  muted: boolean;
}

export interface AudioMixerEventMap {
  sourceAdded: { id: string };
  sourceRemoved: { id: string };
  mixChanged: { sourceCount: number };
  disposed: void;
}

/**
 * Multi-source audio mixer using Web Audio API.
 *
 * Uses GainNode summation (NOT ChannelMergerNode) per W3C spec —
 * multiple connect() calls to the same node auto-sum the signals.
 * Master gain uses 1/sqrt(N) normalization to prevent clipping.
 *
 * @example
 * ```typescript
 * const mixer = new AudioMixer(audioContext);
 * mixer.addSource('mic1', micStream1);
 * mixer.addSource('mic2', micStream2, 0.8);
 *
 * const mixedTrack = mixer.getMixedTrack();
 * // Feed mixedTrack to TranscriptionPipeline
 * ```
 */
export class AudioMixer extends TypedEventEmitter<AudioMixerEventMap> {
  private readonly audioContext: AudioContext;
  private readonly sources: Map<string, AudioMixerSource> = new Map();
  private readonly masterGain: GainNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private disposed = false;

  constructor(audioContext: AudioContext) {
    super();
    this.audioContext = audioContext;
    this.masterGain = audioContext.createGain();
    this.destination = audioContext.createMediaStreamDestination();
    this.masterGain.connect(this.destination);
  }

  addSource(id: string, stream: MediaStream, gain = 1.0): void {
    if (this.disposed) throw new Error('AudioMixer is disposed');
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists`);

    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    const gainNode = this.audioContext.createGain();
    gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);

    sourceNode.connect(gainNode);
    gainNode.connect(this.masterGain);

    this.sources.set(id, { id, stream, sourceNode, gainNode, muted: false });
    this.updateMasterGain();
    this.emit('sourceAdded', { id });
    this.emit('mixChanged', { sourceCount: this.sources.size });
  }

  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) return;

    source.sourceNode.disconnect();
    source.gainNode.disconnect();
    source.stream.getTracks().forEach((t) => t.stop());
    this.sources.delete(id);
    this.updateMasterGain();
    this.emit('sourceRemoved', { id });
    this.emit('mixChanged', { sourceCount: this.sources.size });
  }

  setSourceGain(id: string, gain: number): void {
    const source = this.sources.get(id);
    if (!source) return;
    source.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
  }

  muteSource(id: string, muted: boolean): void {
    const source = this.sources.get(id);
    if (!source) return;

    if (muted && !source.muted) {
      source.gainNode.disconnect();
      source.muted = true;
    } else if (!muted && source.muted) {
      source.gainNode.connect(this.masterGain);
      source.muted = false;
    }
    this.updateMasterGain();
  }

  getSourceCount(): number {
    return this.sources.size;
  }

  getActiveSourceCount(): number {
    let count = 0;
    for (const source of this.sources.values()) {
      if (!source.muted) count++;
    }
    return count;
  }

  getMixedStream(): MediaStream {
    return this.destination.stream;
  }

  getMixedTrack(): MediaStreamTrack | null {
    const tracks = this.destination.stream.getAudioTracks();
    return tracks[0] ?? null;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;

    for (const [id] of this.sources) {
      this.removeSource(id);
    }

    this.masterGain.disconnect();
    this.disposed = true;
    this.emit('disposed');
    this.removeAllListeners();
  }

  private updateMasterGain(): void {
    const activeCount = this.getActiveSourceCount();
    const normalizedGain = activeCount > 0 ? 1.0 / Math.sqrt(activeCount) : 1.0;
    this.masterGain.gain.setValueAtTime(normalizedGain, this.audioContext.currentTime);
  }
}
