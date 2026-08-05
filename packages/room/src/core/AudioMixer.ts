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
  /**
   * Analysis-only tap on this source, present ONLY while per-source level
   * monitoring is running (see {@link AudioMixer.startLevelMonitoring}). It is
   * never connected to the destination, so it contributes nothing to the mix.
   */
  analyser?: AnalyserNode | null;
  /**
   * Resolved from {@link AudioMixerAddSourceOptions.stopTracksOnRemove} at
   * `addSource` time — `true` (stop the tracks on removal/dispose) unless the
   * caller opted out. See that option for why the distinction exists.
   */
  stopTracksOnRemove: boolean;
}

/** Per-source options for {@link AudioMixer.addSource}. */
export interface AudioMixerAddSourceOptions {
  /**
   * Whether the mixer may stop this source's `MediaStreamTrack`s when the
   * source is removed (`removeSource`, and therefore `dispose`, which removes
   * every source). Defaults to `true` — the behaviour every pre-TASK-612
   * caller relies on.
   *
   * Pass `false` for a stream the mixer's CALLER built and still owns (an
   * injected external-microphone stream, a file-backed
   * `MediaStreamAudioDestinationNode.stream`, a remote track). Stopping such a
   * stream is not cleanup, it is destruction of someone else's object: the
   * owner's next session reuses the same `MediaStream`, finds every track
   * `ended`, and gets a structurally valid capture whose uplink carries
   * silence. With `false` the mixer still disconnects the nodes and forgets
   * the source — only the tracks are left alone, for their owner to stop.
   */
  stopTracksOnRemove?: boolean;
}

/** One source's current input level, on the same 0–100 scale the SDK meter uses. */
export interface AudioMixerSourceLevel {
  id: string;
  /** 0–100. Always `0` for a muted source. */
  level: number;
}

export interface AudioMixerLevelMonitorOptions {
  /** Sampling period in ms. Defaults to 100 — the SDK's mixed-meter cadence. */
  intervalMs?: number;
  /** Called once per sample with every source's level, in insertion order. */
  onLevels?: (levels: AudioMixerSourceLevel[]) => void;
}

export interface AudioMixerEventMap {
  sourceAdded: { id: string };
  sourceRemoved: { id: string };
  mixChanged: { sourceCount: number };
  disposed: void;
}

/**
 * Map an RMS amplitude to the 0–100 meter scale.
 *
 * Deliberately IDENTICAL to the mapping `useArcaAudio` applies to its single
 * mixed-stream meter (`min(100, round(rms * 250))`), so a per-source level and
 * the mixed `audio.level` are directly comparable — a UI threshold tuned
 * against one works unchanged against the other.
 */
function rmsToLevel(rms: number): number {
  return Math.min(100, Math.round(rms * 250));
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

  // --- per-source level monitoring (opt-in, off by default) ------------------
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private levelOptions: AudioMixerLevelMonitorOptions = {};
  // Explicitly `Float32Array<ArrayBuffer>` (not the default `ArrayBufferLike`):
  // `getFloatTimeDomainData` rejects a SharedArrayBuffer-backed view, and the
  // shared buffer is reused across sources, so it is allocated once per fftSize.
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;
  private readonly levels: Map<string, number> = new Map();

  constructor(audioContext: AudioContext) {
    super();
    this.audioContext = audioContext;
    this.masterGain = audioContext.createGain();
    this.destination = audioContext.createMediaStreamDestination();
    this.masterGain.connect(this.destination);
  }

  addSource(id: string, stream: MediaStream, gain = 1.0, options: AudioMixerAddSourceOptions = {}): void {
    if (this.disposed) throw new Error('AudioMixer is disposed');
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists`);

    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    const gainNode = this.audioContext.createGain();
    gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);

    sourceNode.connect(gainNode);
    gainNode.connect(this.masterGain);

    // Ownership is decided HERE, once, and stored on the source record: it is a
    // property of where the stream came from, so a later removal never has to
    // guess. `!== false` keeps the default `true` for every existing caller,
    // including one that passes an options object without the key.
    const source: AudioMixerSource = {
      id,
      stream,
      sourceNode,
      gainNode,
      muted: false,
      analyser: null,
      stopTracksOnRemove: options.stopTracksOnRemove !== false,
    };
    this.sources.set(id, source);
    // A source added WHILE monitoring is running gets its tap immediately —
    // otherwise it would silently report 0 for the rest of the session.
    if (this.levelTimer !== null) this.attachAnalyser(source);
    this.updateMasterGain();
    this.emit('sourceAdded', { id });
    this.emit('mixChanged', { sourceCount: this.sources.size });
  }

  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) return;

    this.detachAnalyser(source);
    source.sourceNode.disconnect();
    source.gainNode.disconnect();
    // Unwiring is unconditional; STOPPING the tracks is not. A caller-owned
    // source (`stopTracksOnRemove: false`) leaves this method with its tracks
    // still `live` — the mixer has forgotten it, and its owner decides when it
    // ends (TASK-612).
    if (source.stopTracksOnRemove) source.stream.getTracks().forEach((t) => t.stop());
    this.sources.delete(id);
    this.levels.delete(id);
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

  // ===========================================================================
  // Per-source level monitoring (TASK-597 follow-up #2)
  // ===========================================================================
  //
  // The mixer is the ONLY place in the stack that still has the sources as
  // separate signals — one node chain per input, before they are summed into
  // the single uplink track. Everything downstream (the SDK's mixed-stream
  // meter, the noise filter, VAD, STT) sees one mixed signal and therefore
  // cannot say WHICH microphone is carrying the speech.
  //
  // Monitoring is OPT-IN and costs nothing when off: no analyser nodes are
  // created and no timer runs. When on, ONE timer samples every source (rather
  // than one timer per source) and each tap is an analysis-only `AnalyserNode`
  // hung off the source node — never connected to the destination, so it adds
  // no playback and does not alter the mix.

  /**
   * Start sampling every source's input level.
   *
   * Idempotent: a second call with new options restarts the timer rather than
   * stacking a second one. Returns `false` (and changes nothing) when the
   * runtime cannot analyse — an `AudioContext` without `createAnalyser`, or an
   * analyser without `getFloatTimeDomainData`. Callers treat `false` as "no
   * per-source signal available" rather than an error.
   */
  startLevelMonitoring(options: AudioMixerLevelMonitorOptions = {}): boolean {
    if (this.disposed) return false;
    if (typeof this.audioContext.createAnalyser !== 'function') return false;

    this.stopLevelMonitoring();
    this.levelOptions = options;

    for (const source of this.sources.values()) {
      this.attachAnalyser(source);
    }
    // Nothing could be tapped (e.g. an analyser double without the float
    // time-domain read) — report unsupported instead of running a timer that
    // can only ever publish zeros.
    if (this.sources.size > 0 && !this.hasAnyAnalyser()) {
      this.levelOptions = {};
      return false;
    }

    const intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : 100;
    this.levelTimer = setInterval(() => this.sampleLevels(), intervalMs);
    return true;
  }

  /** Stop sampling and release every analyser tap. Safe to call when not running. */
  stopLevelMonitoring(): void {
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    for (const source of this.sources.values()) {
      this.detachAnalyser(source);
    }
    this.levels.clear();
    this.levelBuffer = null;
    this.levelOptions = {};
  }

  isLevelMonitoringActive(): boolean {
    return this.levelTimer !== null;
  }

  /** Latest sampled level per source, in insertion (mixer) order. */
  getSourceLevels(): AudioMixerSourceLevel[] {
    return Array.from(this.sources.keys()).map((id) => ({ id, level: this.levels.get(id) ?? 0 }));
  }

  /** Latest sampled level for one source; `0` when unknown, muted, or not monitored. */
  getSourceLevel(id: string): number {
    return this.levels.get(id) ?? 0;
  }

  private attachAnalyser(source: AudioMixerSource): void {
    if (source.analyser) return;
    if (typeof this.audioContext.createAnalyser !== 'function') return;
    try {
      const analyser = this.audioContext.createAnalyser();
      if (typeof analyser.getFloatTimeDomainData !== 'function') return;
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      // Tapped off the SOURCE node, deliberately not the gain node: muting
      // calls `gainNode.disconnect()`, which would tear an analyser hung there
      // off the graph and never reconnect it on unmute. A muted source instead
      // reports 0 explicitly in `sampleLevels()`.
      source.sourceNode.connect(analyser);
      source.analyser = analyser;
      this.levels.set(source.id, 0);
    } catch {
      // A runtime that cannot analyse simply has no per-source signal.
      source.analyser = null;
    }
  }

  private detachAnalyser(source: AudioMixerSource): void {
    if (!source.analyser) return;
    try {
      source.analyser.disconnect();
    } catch {
      // Disconnect after context close throws on some platforms — ignore.
    }
    source.analyser = null;
  }

  private hasAnyAnalyser(): boolean {
    for (const source of this.sources.values()) {
      if (source.analyser) return true;
    }
    return false;
  }

  private sampleLevels(): void {
    for (const source of this.sources.values()) {
      if (!source.analyser) continue;
      // A muted source contributes nothing to the mix, so it reads 0 — the
      // level answers "is this input feeding the uplink", not "is the room loud".
      if (source.muted) {
        this.levels.set(source.id, 0);
        continue;
      }
      try {
        const size = source.analyser.fftSize;
        if (!this.levelBuffer || this.levelBuffer.length !== size) {
          this.levelBuffer = new Float32Array(new ArrayBuffer(size * Float32Array.BYTES_PER_ELEMENT));
        }
        const buffer = this.levelBuffer;
        source.analyser.getFloatTimeDomainData(buffer);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = buffer[i] ?? 0;
          sumSquares += sample * sample;
        }
        this.levels.set(source.id, rmsToLevel(Math.sqrt(sumSquares / buffer.length)));
      } catch {
        // A transient analyser read error must never break the mix.
      }
    }
    this.levelOptions.onLevels?.(this.getSourceLevels());
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

    // Kill the sampling timer + analyser taps FIRST: a level timer that
    // outlived its mixer would keep firing against disconnected nodes for the
    // life of the page.
    this.stopLevelMonitoring();

    // Delegated to removeSource so disposal and removal cannot drift apart —
    // which also means dispose honours each source's `stopTracksOnRemove`:
    // caller-owned streams survive the mixer they were mixed in (TASK-612).
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
