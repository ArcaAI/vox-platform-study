/**
 * TASK-1038 E2 (fix 15) — an AUDIO upload's bytes must be the audio container its MIME type names.
 *
 * Attachments were content-sniffed; audio was accepted on its declared type alone
 * (`mime.startsWith('audio/')`), so any bytes — an executable, an HTML page — could be stored in
 * the tenant's recordings bucket labelled `audio/wav` and later handed to an ASR worker. Now:
 *
 * - the audio allow-list is ONE list (`MEDIA_AUDIO_MIME_TYPES`, the batch-transcription list), used
 *   by the service AND the `POST /media` controller — a type outside it is 400
 *   `MEDIA_TYPE_UNSUPPORTED` even when it starts with `audio/`;
 * - the bytes must carry the container's magic: RIFF/WAVE, ID3 or an MPEG frame sync, OggS, fLaC,
 *   EBML (webm/matroska), an MP4 `ftyp` box, or an ADTS sync for AAC — else 400
 *   `MEDIA_CONTENT_MISMATCH`, before anything is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY, MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY } from '../../settings-registry/descriptors/media-upload.descriptors';
import { MEDIA_AUDIO_MIME_TYPES, MediaUploadService } from '../media-upload.service';

const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(64)]);
const WAV = pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]));
const ID3 = pad(Buffer.from('ID3\x04\x00', 'latin1'));
const MPEG_FRAME = pad(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
const OGG = pad(Buffer.from('OggS'));
const FLAC = pad(Buffer.from('fLaC'));
const WEBM = pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
const MP4 = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')]));
const ADTS = pad(Buffer.from([0xff, 0xf1, 0x50, 0x80]));
const HTML = pad(Buffer.from('<!doctype html><script>'));

const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)), set: vi.fn() };
const media = { create: vi.fn(async (request: Record<string, unknown>) => ({ id: 'media-1', ...request })) };
const buckets = { getBucketByPurpose: vi.fn(async () => ({ id: 'b', name: 'tenant-1-recordings' })), getBucketBySlug: vi.fn() };
const blob = { putObject: vi.fn(), deleteObject: vi.fn() };
const settings = {
  resolvePlatform: vi.fn((key: string) => ({ key, value: key === MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY ? 250 : key === MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY ? 25 : undefined })),
};
const build = () =>
  new MediaUploadService({ emit: vi.fn() } as never, cls as never, media as never, {} as never, buckets as never, blob as never, settings as never);

beforeEach(() => {
  blob.putObject.mockClear();
  media.create.mockClear();
});

async function refusal(buffer: Buffer, mimeType: string): Promise<string | undefined> {
  const error = await build()
    .upload({ category: 'audio', buffer, mimeType })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  expect(blob.putObject).not.toHaveBeenCalled();
  return ((error as BadRequestException).getResponse() as { code?: string }).code;
}

describe('audio content sniffing', () => {
  it.each([
    ['audio/wav', WAV],
    ['audio/wave', WAV],
    ['audio/x-wav', WAV],
    ['audio/mpeg', ID3],
    ['audio/mpeg', MPEG_FRAME],
    ['audio/mp3', ID3],
    ['audio/ogg', OGG],
    ['audio/flac', FLAC],
    ['audio/x-flac', FLAC],
    ['audio/webm', WEBM],
    ['audio/mp4', MP4],
    ['audio/x-m4a', MP4],
    ['audio/aac', ADTS],
  ])('%s with the matching container is stored', async (mimeType, buffer) => {
    await expect(build().upload({ category: 'audio', buffer, mimeType })).resolves.toMatchObject({ mime: mimeType });
  });

  it('bytes that are no audio container are 400 MEDIA_CONTENT_MISMATCH, before any write', async () => {
    expect(await refusal(HTML, 'audio/wav')).toBe('MEDIA_CONTENT_MISMATCH');
  });

  it('a container that is not the declared type is refused (OggS labelled audio/wav)', async () => {
    expect(await refusal(OGG, 'audio/wav')).toBe('MEDIA_CONTENT_MISMATCH');
  });

  it('an audio/* type outside the allow-list is 400 MEDIA_TYPE_UNSUPPORTED', async () => {
    expect(await refusal(WAV, 'audio/x-ms-wma')).toBe('MEDIA_TYPE_UNSUPPORTED');
  });

  it('the allow-list is the batch-transcription list', () => {
    expect([...MEDIA_AUDIO_MIME_TYPES].sort()).toEqual(
      ['audio/aac', 'audio/flac', 'audio/mp3', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/webm', 'audio/x-flac', 'audio/x-m4a', 'audio/x-wav'].sort(),
    );
  });
});
