/**
 * TASK-304 Wave 3 hotfix — Float32Array → WAV blob.
 *
 * The local-AI transcript panel records a parallel `MediaRecorder` (webm/opus)
 * stream for whole-session playback, but seeking into a partial WebM blob during
 * active capture is unreliable: Chromium reports `audio.duration` as either
 * `Infinity` or a tiny metadata-only value while the recorder is still
 * accumulating chunks, which collapses the playback window to a few ms.
 *
 * For per-segment replay we already have the exact Float32Array the VAD handed
 * us in `onSpeechEnd` (16 kHz mono PCM, already padded). Encoding it as a
 * stand-alone WAV blob gives the `<audio>` element accurate duration metadata
 * and lets the user hear the full segment without any seek math.
 *
 * Keep this helper minimal — 16-bit PCM mono is the only shape the local
 * pipeline produces today; if/when stereo or float-PCM is needed, extend here
 * rather than introducing a second encoder.
 */
export interface EncodedWav {
  blob: Blob;
  /** Seconds (samples / sampleRate). Used for entry duration sanity checks. */
  durationSec: number;
}

const WAV_HEADER_SIZE = 44;
const BYTES_PER_SAMPLE = 2;
const PCM_FORMAT_TAG = 1;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Encode a Float32Array (assumed mono PCM in [-1, 1]) as a `audio/wav` Blob.
 *
 * @param audio    Source samples. Values are clamped to [-1, 1] before quantisation.
 * @param sampleRate Sample rate in Hz (e.g. 16000 for the VAD output).
 * @returns Object with the WAV Blob and the precise duration in seconds.
 */
export function encodeWavBlob(audio: Float32Array, sampleRate: number): EncodedWav {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWavBlob: sampleRate must be > 0, got ${sampleRate}`);
  }

  const sampleCount = audio.length;
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_SIZE - 8 + dataSize, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT_TAG, true);
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_SIZE;
  for (let i = 0; i < sampleCount; i++) {
    const raw = audio[i];
    // NaN cannot be clamped (every comparison is false); coerce it to silence
    // first, then let `Math.max(-1, Math.min(1, ...))` handle ±Infinity naturally.
    const safe = typeof raw === 'number' && !Number.isNaN(raw) ? raw : 0;
    const sample = Math.max(-1, Math.min(1, safe));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += BYTES_PER_SAMPLE;
  }

  return {
    blob: new Blob([buffer], { type: 'audio/wav' }),
    durationSec: sampleCount / sampleRate,
  };
}
