/**
 * BUG-028 — browser-recorded enrollment samples. Nest's FileTypeValidator sniffs magic numbers,
 * and `file-type` reports any WebM/MP4 container as `video/*` (it cannot tell audio-only apart),
 * so Chrome's `audio/webm` and Safari's `audio/mp4` recordings were refused by `/^audio\//`.
 * OD-1: a recorder container passes only when the upload itself declares audio.
 */
import { FileTypeValidator } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AudioUploadTypeValidator } from '../audio-upload-type.validator';

function ebml(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | payload.length]), payload]);
}

/** A minimal EBML header with DocType `webm` — what MediaRecorder's output starts with. */
const WEBM = (() => {
  const header = Buffer.concat([
    ebml([0x42, 0x86], Buffer.from([1])),
    ebml([0x42, 0xf7], Buffer.from([1])),
    ebml([0x42, 0x82], Buffer.from('webm')),
    ebml([0x42, 0x87], Buffer.from([4])),
    ebml([0x42, 0x85], Buffer.from([2])),
  ]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | header.length]), header, Buffer.alloc(64)]);
})();

function ftyp(brand: string): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4);
  box.write(brand, 8);
  box.write('isom', 16);
  box.write(brand, 20);
  return box;
}

const MP4 = ftyp('iso5'); // Safari MediaRecorder — sniffed video/mp4
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length });

describe('AudioUploadTypeValidator (BUG-028)', () => {
  const validator = new AudioUploadTypeValidator();

  it('reproduces the defect: the route’s former /^audio\\// sniffing validator refuses a Chrome WebM recording', async () => {
    expect(await new FileTypeValidator({ fileType: /^audio\// }).isValid(file(WEBM, 'audio/webm'))).toBe(false);
  });

  it.each([
    ['audio/webm'],
    ['audio/webm;codecs=opus'],
  ])('accepts a Chrome WebM recording declared %s (sniffed video/webm)', async (mimetype) => {
    expect(await validator.isValid(file(WEBM, mimetype))).toBe(true);
  });

  it('accepts a Safari MP4 recording declared audio/mp4 (sniffed video/mp4)', async () => {
    expect(await validator.isValid(file(MP4, 'audio/mp4'))).toBe(true);
  });

  it('accepts a sniffed audio file whatever the client declared', async () => {
    expect(await validator.isValid(file(WAV, 'audio/wav'))).toBe(true);
    expect(await validator.isValid(file(WAV, 'application/octet-stream'))).toBe(true);
  });

  it('refuses a recorder container the client did not declare as audio', async () => {
    expect(await validator.isValid(file(WEBM, 'video/webm'))).toBe(false);
    expect(await validator.isValid(file(MP4, 'video/mp4'))).toBe(false);
  });

  it('refuses a non-media file declared as audio (spoof)', async () => {
    expect(await validator.isValid(file(JPEG, 'audio/webm'))).toBe(false);
  });

  it('names the declared type in its error message', () => {
    expect(validator.buildErrorMessage(file(JPEG, 'audio/webm'))).toMatch(/audio/i);
  });
});
