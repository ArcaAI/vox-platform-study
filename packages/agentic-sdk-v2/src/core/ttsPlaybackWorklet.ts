/**
 * TASK-491 — AudioWorklet PLAYBACK ring buffer for streamed TTS audio.
 *
 * The first output (playback) worklet in the repo — existing ones are all
 * capture (input) processors. It receives Float32 mono frames (already resampled
 * to the AudioContext rate by `TtsPlaybackPlayer`) via `port.postMessage` and
 * emits them gaplessly on `outputs[0][0]`, emitting silence on underrun and a
 * one-shot `{type:'ended'}` message once the stream has ended and drained.
 *
 * Built on `@arcaai/room`'s `createWorkletLoader` (inline source → blob URL,
 * double-registration guarded), mirroring `@arcaai/noise-filter`'s loader.
 */

import { createWorkletLoader } from '@arcaai/room';

export const TTS_PLAYBACK_PROCESSOR_NAME = 'tts-playback-processor';

function generateWorkletSource(): string {
  return `
class TtsPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._current = null;
    this._offset = 0;
    this._ended = false;
    this._notifiedEnded = false;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'chunk') {
        this._chunks.push(msg.samples);
      } else if (msg.type === 'end') {
        this._ended = true;
      } else if (msg.type === 'flush') {
        this._chunks = [];
        this._current = null;
        this._offset = 0;
        this._ended = false;
        this._notifiedEnded = false;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (!this._current || this._offset >= this._current.length) {
        this._current = this._chunks.shift() || null;
        this._offset = 0;
      }
      if (!this._current) {
        while (i < out.length) out[i++] = 0;
        if (this._ended && this._chunks.length === 0 && !this._notifiedEnded) {
          this._notifiedEnded = true;
          this.port.postMessage({ type: 'ended' });
        }
        break;
      }
      out[i++] = this._current[this._offset++];
    }
    return true;
  }
}
registerProcessor('${TTS_PLAYBACK_PROCESSOR_NAME}', TtsPlaybackProcessor);
`;
}

const loader = createWorkletLoader({ generateSource: generateWorkletSource, label: 'TtsPlayback' });

export async function registerTtsPlaybackWorklet(ctx: AudioContext, workletUrl?: string): Promise<void> {
  await loader.register(ctx, workletUrl);
}

export function isTtsPlaybackWorkletRegistered(ctx: AudioContext): boolean {
  return loader.isRegistered(ctx);
}

export function createTtsPlaybackNode(ctx: AudioContext): AudioWorkletNode {
  if (!loader.isRegistered(ctx)) {
    throw new Error('TTS playback worklet is not registered — call registerTtsPlaybackWorklet(ctx) first');
  }
  return new AudioWorkletNode(ctx, TTS_PLAYBACK_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
}
