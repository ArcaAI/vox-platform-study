/**
 * Audio duration probe (TASK-604 lane B).
 *
 * The batch upload route enforces "each recording at most 60 minutes", so it
 * needs the DURATION of an uploaded buffer before it dispatches any work. This
 * probe reads it out of the container header — no decode, no dependency, no
 * subprocess.
 *
 * The fixtures below are synthesized byte-for-byte rather than checked in as
 * binaries: a header this code parses is small enough to build in the test, and
 * building it here documents exactly which fields the parser depends on.
 *
 * Dispatch is by MAGIC BYTES, never by the client-supplied MIME type — a caller
 * can label anything `audio/wav`.
 */

import { describe, expect, it } from 'vitest';
import { probeAudioDurationSeconds } from '../audio-duration';

// ── fixture builders ────────────────────────────────────────────────────────

/** RIFF/WAVE, 16-bit PCM. `seconds` of silence at `sampleRate`/`channels`. */
function wav(seconds: number, sampleRate = 16000, channels = 1): Buffer {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = Math.round(seconds * byteRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32); // block align
  header.writeUInt16LE(8 * bytesPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  // The parser reads the DECLARED data size, so the payload need not be present
  // in full — this keeps a 60-minute fixture from allocating 115 MB.
  return Buffer.concat([header, Buffer.alloc(Math.min(dataSize, 64))]);
}

/** fLaC + a STREAMINFO block carrying sampleRate and totalSamples. */
function flac(seconds: number, sampleRate = 44100): Buffer {
  const totalSamples = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(4 + 4 + 34);
  buf.write('fLaC', 0, 'ascii');
  buf.writeUInt8(0x80, 4); // last-metadata-block flag + type 0 (STREAMINFO)
  buf.writeUIntBE(34, 5, 3); // block length
  // STREAMINFO body starts at 8; the packed field runs from byte 18:
  //   sampleRate (20 bits) | channels-1 (3) | bitsPerSample-1 (5) | totalSamples (36)
  const packed = (BigInt(sampleRate) << BigInt(44)) | (BigInt(0) << BigInt(41)) | (BigInt(15) << BigInt(36)) | BigInt(totalSamples);
  buf.writeBigUInt64BE(packed, 8 + 10);
  return buf;
}

/** ISO-BMFF (`.m4a`/`.mp4`) with a version-0 `mvhd` inside `moov`. */
function mp4(seconds: number, timescale = 44100): Buffer {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt8(0, 0); // version 0
  mvhdBody.writeUInt32BE(timescale, 12);
  mvhdBody.writeUInt32BE(Math.round(seconds * timescale), 16);
  const mvhd = Buffer.concat([sizedAtom('mvhd', mvhdBody)]);
  const moov = sizedAtom('moov', mvhd);
  const ftyp = sizedAtom('ftyp', Buffer.from('M4A isom', 'ascii'));
  return Buffer.concat([ftyp, moov]);
}

function sizedAtom(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

/** Ogg Opus: an OpusHead first page, then a final page whose granule is 48 kHz-based. */
function oggOpus(seconds: number): Buffer {
  const first = oggPage(Buffer.concat([Buffer.from('OpusHead', 'ascii'), Buffer.alloc(11)]), 0n, 0x02);
  const last = oggPage(Buffer.alloc(8), BigInt(Math.round(seconds * 48000)), 0x04);
  return Buffer.concat([first, last]);
}

function oggPage(payload: Buffer, granule: bigint, headerType: number): Buffer {
  const segments = Math.ceil(payload.length / 255) || 1;
  const header = Buffer.alloc(27 + segments);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(headerType, 5);
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14); // serial
  header.writeUInt8(segments, 26);
  let remaining = payload.length;
  for (let i = 0; i < segments; i += 1) {
    header.writeUInt8(Math.min(remaining, 255), 27 + i);
    remaining -= 255;
  }
  return Buffer.concat([header, payload]);
}

/** Matroska/WebM: Segment → Info → TimecodeScale + Duration (8-byte float). */
function webm(seconds: number, timecodeScale = 1_000_000): Buffer {
  const timecodeScaleEl = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(timecodeScale));
  const durationBody = Buffer.alloc(8);
  durationBody.writeDoubleBE((seconds * 1e9) / timecodeScale, 0);
  const durationEl = ebmlElement([0x44, 0x89], durationBody);
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], Buffer.concat([timecodeScaleEl, durationEl]));
  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], info);
  const ebmlHeader = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(4));
  return Buffer.concat([ebmlHeader, segment]);
}

/** EBML element with an 8-byte (always-marked) size field — valid, if not compact. */
function ebmlElement(id: number[], body: Buffer): Buffer {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (BigInt(1) << BigInt(56)), 0);
  return Buffer.concat([Buffer.from(id), size, body]);
}

function uintBytes(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

/** MPEG-1 Layer III CBR: one valid frame header, then `bytes` of payload. */
function mp3Cbr(seconds: number, kbps = 128, sampleRate = 44100): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(0xfb, 1); // MPEG-1, Layer III, no CRC
  header.writeUInt8(0x90, 2); // bitrate index 9 (128 kbps), sample-rate index 0 (44100)
  header.writeUInt8(0x00, 3);
  const payloadBytes = Math.round((seconds * kbps * 1000) / 8) - 4;
  void sampleRate;
  return Buffer.concat([header, Buffer.alloc(Math.max(payloadBytes, 0))]);
}

// ── the contract ────────────────────────────────────────────────────────────

describe('probeAudioDurationSeconds', () => {
  it('reads WAV duration from the fmt byte-rate and the data chunk size', () => {
    expect(probeAudioDurationSeconds(wav(30))).toBeCloseTo(30, 3);
    expect(probeAudioDurationSeconds(wav(3600))).toBeCloseTo(3600, 3);
  });

  it('reads WAV duration for stereo / non-16 kHz captures', () => {
    expect(probeAudioDurationSeconds(wav(12.5, 48000, 2))).toBeCloseTo(12.5, 3);
  });

  it('reads FLAC duration from STREAMINFO totalSamples / sampleRate', () => {
    expect(probeAudioDurationSeconds(flac(61 * 60))).toBeCloseTo(61 * 60, 2);
  });

  it('reads MP4/M4A duration from the mvhd atom', () => {
    expect(probeAudioDurationSeconds(mp4(125))).toBeCloseTo(125, 2);
  });

  it('reads Ogg Opus duration from the final page granule position (48 kHz)', () => {
    expect(probeAudioDurationSeconds(oggOpus(42))).toBeCloseTo(42, 2);
  });

  it('reads WebM/Matroska duration from Info.Duration × TimecodeScale', () => {
    expect(probeAudioDurationSeconds(webm(75))).toBeCloseTo(75, 2);
  });

  it('estimates CBR MP3 duration from the frame header bitrate', () => {
    expect(probeAudioDurationSeconds(mp3Cbr(20))).toBeCloseTo(20, 1);
  });

  it('skips an ID3v2 tag before looking for the first MP3 frame', () => {
    const id3 = Buffer.alloc(10 + 500);
    id3.write('ID3', 0, 'ascii');
    id3.writeUInt8(3, 3); // version
    // synchsafe size = 500
    id3.writeUInt8(0, 6);
    id3.writeUInt8(0, 7);
    id3.writeUInt8(3, 8);
    id3.writeUInt8(0x74, 9);
    expect(probeAudioDurationSeconds(Buffer.concat([id3, mp3Cbr(10)]))).toBeCloseTo(10, 1);
  });

  it('dispatches on magic bytes, not on a caller-supplied MIME type', () => {
    // Labelled wav, actually flac — the FLAC duration must win.
    expect(probeAudioDurationSeconds(flac(90), 'audio/wav')).toBeCloseTo(90, 2);
  });

  it('returns null for a buffer whose container it cannot identify', () => {
    expect(probeAudioDurationSeconds(Buffer.from('not audio at all, just bytes'))).toBeNull();
  });

  it('returns null (never throws or hangs) on a truncated header', () => {
    expect(probeAudioDurationSeconds(wav(30).subarray(0, 20))).toBeNull();
    expect(probeAudioDurationSeconds(flac(30).subarray(0, 9))).toBeNull();
    expect(probeAudioDurationSeconds(mp4(30).subarray(0, 12))).toBeNull();
    expect(probeAudioDurationSeconds(webm(30).subarray(0, 10))).toBeNull();
    expect(probeAudioDurationSeconds(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a WAV whose declared byte rate is zero (undecidable)', () => {
    const broken = wav(30);
    broken.writeUInt32LE(0, 28); // byteRate
    broken.writeUInt32LE(0, 24); // sampleRate — no way to recompute it either
    expect(probeAudioDurationSeconds(broken)).toBeNull();
  });

  it('returns null for a WebM whose Duration element is absent (live/streamed capture)', () => {
    // MediaRecorder output frequently omits Duration; the caller must be able to
    // tell "unknown" apart from "zero".
    const timecodeScale = ebmlElement([0x2a, 0xd7, 0xb1], uintBytes(1_000_000));
    const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], timecodeScale);
    const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], info);
    const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(4));
    expect(probeAudioDurationSeconds(Buffer.concat([header, segment]))).toBeNull();
  });

  it('returns null rather than 0 for a zero-length recording', () => {
    // A 0-second file is not "under the limit" — it is a broken upload, and the
    // route must not treat it as a measured, acceptable duration.
    expect(probeAudioDurationSeconds(wav(0))).toBeNull();
  });
});
