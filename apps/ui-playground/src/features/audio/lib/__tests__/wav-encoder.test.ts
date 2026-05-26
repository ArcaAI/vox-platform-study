/**
 * TASK-304 Wave 3 hotfix — wav-encoder unit tests.
 *
 * Verifies the headers and per-sample quantisation rather than relying on
 * `AudioContext.decodeAudioData` (jsdom does not implement it).
 */
import { describe, expect, it } from 'vitest';
import { encodeWavBlob } from '../wav-encoder';

async function readBytes(blob: Blob): Promise<DataView> {
  const buffer = await blob.arrayBuffer();
  return new DataView(buffer);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('encodeWavBlob', () => {
  it('writes the canonical RIFF/WAVE/fmt /data chunks for 16 kHz mono', async () => {
    const audio = new Float32Array(16000);
    const { blob, durationSec } = encodeWavBlob(audio, 16000);

    expect(blob.type).toBe('audio/wav');
    expect(durationSec).toBeCloseTo(1.0, 6);

    const view = await readBytes(blob);
    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + audio.length * 2);
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(16000 * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(readAscii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(audio.length * 2);
  });

  it('quantises Float32 samples to little-endian Int16', async () => {
    const audio = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const { blob } = encodeWavBlob(audio, 16000);
    const view = await readBytes(blob);

    // `setInt16` truncates fractional values toward zero (ECMAScript ToInt16
    // algorithm); we assert against the same truncation rather than rounding.
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(view.getInt16(52, true)).toBe(Math.trunc(-0.5 * 0x8000));
  });

  it('clamps out-of-range samples and replaces NaN with 0', async () => {
    const audio = new Float32Array([2.5, -2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    const { blob } = encodeWavBlob(audio, 16000);
    const view = await readBytes(blob);

    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
  });

  it('rejects non-positive sample rates', () => {
    expect(() => encodeWavBlob(new Float32Array(1), 0)).toThrow(RangeError);
    expect(() => encodeWavBlob(new Float32Array(1), -1)).toThrow(RangeError);
    expect(() => encodeWavBlob(new Float32Array(1), Number.NaN)).toThrow(RangeError);
  });

  it('handles an empty buffer (zero samples, but valid header)', async () => {
    const { blob, durationSec } = encodeWavBlob(new Float32Array(0), 16000);
    expect(durationSec).toBe(0);
    const view = await readBytes(blob);
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(40, true)).toBe(0);
  });
});
