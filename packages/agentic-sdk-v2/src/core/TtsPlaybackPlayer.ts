/**
 * TASK-491 — Streaming TTS playback via Web Audio.
 *
 * Converts raw PCM s16le (mono, 24 kHz from tts-v2) → Float32, resamples to the
 * shared AudioContext's rate (capture may hold 48 kHz), and feeds frames into the
 * `tts-playback-processor` ring buffer as they arrive. PCM16 samples that straddle
 * a network-chunk boundary are carried over via `_leftover` so no sample is split.
 */

import { AudioContextManager } from '@arcaai/room';

import { createTtsPlaybackNode, registerTtsPlaybackWorklet } from './ttsPlaybackWorklet';

/** tts-v2 emits raw PCM at 24 kHz mono. */
export const TTS_SOURCE_SAMPLE_RATE = 24000;

export interface TtsPlaybackPlayerOptions {
  sourceRate?: number;
  onEnded?: () => void;
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const sample = view.getInt16(i * 2, true); // little-endian s16le
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return out;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

export class TtsPlaybackPlayer {
  private readonly ctxManager = AudioContextManager.getInstance({ sampleRate: TTS_SOURCE_SAMPLE_RATE });
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly sourceRate: number;
  private readonly onEnded?: () => void;
  private started = false;
  private leftover: Uint8Array | null = null;

  constructor(options: TtsPlaybackPlayerOptions = {}) {
    this.sourceRate = options.sourceRate ?? TTS_SOURCE_SAMPLE_RATE;
    this.onEnded = options.onEnded;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.ctx = await this.ctxManager.acquire();
    await this.ctxManager.resume();
    await registerTtsPlaybackWorklet(this.ctx);
    this.node = createTtsPlaybackNode(this.ctx);
    this.node.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'ended') this.onEnded?.();
    };
    this.node.connect(this.ctx.destination);
    this.started = true;
  }

  /** Feed a raw PCM s16le chunk; resamples to the ctx rate and posts Float32 frames. */
  enqueuePcm16(bytes: Uint8Array): void {
    if (!this.node || !this.ctx) throw new Error('TtsPlaybackPlayer not started');

    let buffer = bytes;
    if (this.leftover) {
      const merged = new Uint8Array(this.leftover.length + bytes.length);
      merged.set(this.leftover);
      merged.set(bytes, this.leftover.length);
      buffer = merged;
      this.leftover = null;
    }
    const evenLen = buffer.length - (buffer.length % 2);
    if (evenLen < buffer.length) {
      this.leftover = buffer.slice(evenLen); // carry the trailing half-sample
    }
    if (evenLen === 0) return;

    const floats = pcm16ToFloat32(buffer.subarray(0, evenLen));
    const samples = resampleLinear(floats, this.sourceRate, this.ctx.sampleRate);
    this.node.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
  }

  /** Signal end-of-stream; the worklet fires `onEnded` once it drains. */
  end(): void {
    this.node?.port.postMessage({ type: 'end' });
  }

  async stop(): Promise<void> {
    this.leftover = null;
    if (this.node) {
      this.node.port.postMessage({ type: 'flush' });
      try {
        this.node.disconnect();
      } catch {
        // already disconnected
      }
      this.node = null;
    }
    if (this.started) {
      this.ctxManager.release();
      this.started = false;
    }
    this.ctx = null;
  }
}
