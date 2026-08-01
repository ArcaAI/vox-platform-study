/**
 * File-backed capture sources — "simulate a recording" for the developer console.
 *
 * The SDK's `audio.start({ sourceStreams })` seam (TASK-597) accepts any
 * `MediaStream`, so a decoded audio FILE can drive the exact same
 * mixer → noise-filter → VAD → STT graph a microphone drives. That identity is
 * the whole point: a deterministic, repeatable run is only meaningful for
 * WER/CER if it exercises the real pipeline rather than a shortcut around it.
 *
 * The chain per virtual mic is:
 *
 *   File → decodeAudioData → AudioBuffer → AudioBufferSourceNode
 *        → MediaStreamAudioDestinationNode → .stream  ⟶  sourceStreams[i]
 *
 * Web Audio has no pause/seek on a source node — a node is one-shot. So the
 * group below models playback as (bufferStartedAt, offset) and rebuilds the
 * nodes on every play/seek, which is the standard approach and keeps every
 * virtual mic sample-aligned because they all restart from the same offset.
 */

/** One decoded virtual microphone: a mono buffer plus the stream it feeds. */
export interface FileAudioSourceTrack {
  /** Stable id, e.g. `file-1`. */
  id: string;
  /** Human label shown in the UI, e.g. `notes.wav` or `notes.wav (L)`. */
  label: string;
  /** The stream handed to `audio.start({ sourceStreams })`. */
  stream: MediaStream;
  /** Seconds of audio in this track. */
  duration: number;
}

export interface FileAudioInput {
  file: File;
  /**
   * Split a stereo file into TWO virtual mics (left → mic N, right → mic N+1).
   * Ignored for mono files. This is how one recording of a two-person
   * consultation becomes a two-mic session.
   */
  splitStereo?: boolean;
}

/** Decode + playback errors surface as this so the UI can toast a real reason. */
export class FileAudioSourceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FileAudioSourceError';
  }
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor {
  const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new FileAudioSourceError('Web Audio is unavailable in this browser — file playback needs AudioContext.');
  return Ctor;
}

/** Extract one channel of an AudioBuffer as a standalone mono buffer. */
function extractChannel(ctx: AudioContext, buffer: AudioBuffer, channel: number): AudioBuffer {
  const mono = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  mono.copyToChannel(buffer.getChannelData(channel), 0);
  return mono;
}

interface DecodedTrack {
  id: string;
  label: string;
  buffer: AudioBuffer;
  destination: MediaStreamAudioDestinationNode;
  node: AudioBufferSourceNode | null;
}

/**
 * A set of file-backed virtual microphones driven as one transport.
 *
 * Every track shares the group's play/pause/seek/loop/rate, so an N-file
 * "multi-mic" run stays aligned. Build it with {@link FileAudioSourceGroup.create},
 * hand `streams` to `audio.start({ sourceStreams })`, and `dispose()` it when
 * the run ends.
 */
export class FileAudioSourceGroup {
  private readonly ctx: AudioContext;
  private readonly tracks: DecodedTrack[];
  /** Playback offset (seconds) at the moment playback last started. */
  private offset = 0;
  /** `ctx.currentTime` when playback last started, or `null` while paused. */
  private startedAt: number | null = null;
  private loop = false;
  private rate = 1;
  private disposed = false;

  private constructor(ctx: AudioContext, tracks: DecodedTrack[]) {
    this.ctx = ctx;
    this.tracks = tracks;
  }

  /**
   * Decode every input into virtual mics. A stereo input with
   * `splitStereo: true` yields two.
   */
  static async create(inputs: FileAudioInput[]): Promise<FileAudioSourceGroup> {
    if (inputs.length === 0) throw new FileAudioSourceError('Select at least one audio file.');
    const Ctor = resolveAudioContextCtor();
    // 48 kHz matches the SDK's AudioContextManager, so no resampling surprise
    // is introduced between a file run and a mic run.
    const ctx = new Ctor({ sampleRate: 48000 });

    const tracks: DecodedTrack[] = [];
    try {
      for (const input of inputs) {
        const bytes = await input.file.arrayBuffer();
        let decoded: AudioBuffer;
        try {
          decoded = await ctx.decodeAudioData(bytes);
        } catch (err) {
          throw new FileAudioSourceError(`Could not decode "${input.file.name}" — is it a supported audio format?`, err);
        }

        const wantsSplit = Boolean(input.splitStereo) && decoded.numberOfChannels >= 2;
        const parts: { label: string; buffer: AudioBuffer }[] = wantsSplit
          ? [
              { label: `${input.file.name} (L)`, buffer: extractChannel(ctx, decoded, 0) },
              { label: `${input.file.name} (R)`, buffer: extractChannel(ctx, decoded, 1) },
            ]
          : [{ label: input.file.name, buffer: decoded }];

        for (const part of parts) {
          tracks.push({
            id: `file-${tracks.length + 1}`,
            label: part.label,
            buffer: part.buffer,
            destination: ctx.createMediaStreamDestination(),
            node: null,
          });
        }
      }
    } catch (err) {
      await ctx.close().catch(() => {});
      throw err;
    }

    return new FileAudioSourceGroup(ctx, tracks);
  }

  /** The virtual mics, in mixer order. */
  get sources(): FileAudioSourceTrack[] {
    return this.tracks.map((t) => ({
      id: t.id,
      label: t.label,
      stream: t.destination.stream,
      duration: t.buffer.duration,
    }));
  }

  /** Streams to hand to `audio.start({ sourceStreams })`. */
  get streams(): MediaStream[] {
    return this.tracks.map((t) => t.destination.stream);
  }

  /** Longest track — what the seek bar spans. */
  get duration(): number {
    return this.tracks.reduce((max, t) => Math.max(max, t.buffer.duration), 0);
  }

  get isPlaying(): boolean {
    return this.startedAt !== null;
  }

  /** Current playback position in seconds, clamped to `duration`. */
  get currentTime(): number {
    if (this.startedAt === null) return this.offset;
    const elapsed = (this.ctx.currentTime - this.startedAt) * this.rate;
    const position = this.offset + elapsed;
    if (this.loop && this.duration > 0) return position % this.duration;
    return Math.min(position, this.duration);
  }

  async play(): Promise<void> {
    this.assertLive();
    if (this.startedAt !== null) return;
    // Browsers start contexts suspended until a user gesture; play() is always
    // called from a click, so this is the right place to resume.
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const startOffset = this.offset >= this.duration && !this.loop ? 0 : this.offset;
    this.offset = startOffset;
    this.startedAt = this.ctx.currentTime;
    for (const track of this.tracks) {
      const node = this.ctx.createBufferSource();
      node.buffer = track.buffer;
      node.loop = this.loop;
      node.playbackRate.value = this.rate;
      node.connect(track.destination);
      node.start(0, Math.min(startOffset, track.buffer.duration));
      track.node = node;
    }
  }

  pause(): void {
    if (this.disposed || this.startedAt === null) return;
    this.offset = this.currentTime;
    this.stopNodes();
    this.startedAt = null;
  }

  /** Seek to `seconds`; keeps playing if it was playing. */
  seek(seconds: number): void {
    this.assertLive();
    const wasPlaying = this.startedAt !== null;
    this.stopNodes();
    this.startedAt = null;
    this.offset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) void this.play();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    for (const track of this.tracks) {
      if (track.node) track.node.loop = loop;
    }
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    // Re-anchor first, otherwise the elapsed time already played would be
    // re-scaled by the NEW rate and the position would jump.
    if (this.startedAt !== null) {
      this.offset = this.currentTime;
      this.startedAt = this.ctx.currentTime;
    }
    this.rate = rate;
    for (const track of this.tracks) {
      if (track.node) track.node.playbackRate.value = rate;
    }
  }

  /** Stop playback and release every node, stream track, and the context. */
  dispose(): void {
    if (this.disposed) return;
    this.stopNodes();
    this.startedAt = null;
    this.disposed = true;
    for (const track of this.tracks) {
      track.destination.stream.getTracks().forEach((t) => t.stop());
      try {
        track.destination.disconnect();
      } catch {
        // Disconnect after context close throws on some platforms — ignore.
      }
    }
    void this.ctx.close?.().catch(() => {});
  }

  private stopNodes(): void {
    for (const track of this.tracks) {
      if (!track.node) continue;
      try {
        track.node.stop();
      } catch {
        // A node that already ended throws on stop() — expected.
      }
      try {
        track.node.disconnect();
      } catch {
        // Ignore — see above.
      }
      track.node = null;
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new FileAudioSourceError('This file source group has been disposed.');
  }
}
