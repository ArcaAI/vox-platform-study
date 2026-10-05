// Content sniffing shared by `POST /media` and the consultation attachment flow: the declared MIME
// type is never trusted alone — the bytes must be the container it names.

/** Bytes an attachment of each binary type must start with (the client-declared MIME type is never trusted alone). */
export const ATTACHMENT_SIGNATURES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/**
 * TASK-1038 E2 (fix 15) — the ONE audio allow-list of `POST /media` (the controller and this
 * service), the same list the batch-transcription upload accepts. A type outside it is refused
 * even when it starts with `audio/`.
 */
export const MEDIA_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'audio/aac',
]);

const ascii = (b: Buffer, start: number, text: string): boolean =>
  b.length >= start + text.length && b.subarray(start, start + text.length).toString('latin1') === text;
/** RIFF/WAVE. */
const isWave = (b: Buffer): boolean => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE');
/** An ID3v2 tag, or an MPEG audio frame sync (11 set bits, a layer that is not reserved). */
const isMpeg = (b: Buffer): boolean => ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0);
/** An ADTS frame sync (AAC): 12 set bits, layer 00. */
const isAdts = (b: Buffer): boolean => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0;
/** An ISO-BMFF `ftyp` box (MP4 / M4A). */
const isMp4 = (b: Buffer): boolean => ascii(b, 4, 'ftyp');
/** The EBML header of a WebM / Matroska file. */
const isEbml = (b: Buffer): boolean => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

/**
 * TASK-1038 E2 (fix 15) — the container magic an audio upload of each type must start with. Never
 * the declared type alone: a body that is not that container is `MEDIA_CONTENT_MISMATCH`.
 */
export const AUDIO_SIGNATURES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  'audio/wav': isWave,
  'audio/wave': isWave,
  'audio/x-wav': isWave,
  'audio/mpeg': isMpeg,
  'audio/mp3': isMpeg,
  'audio/mp4': isMp4,
  'audio/x-m4a': isMp4,
  'audio/aac': (b) => isAdts(b) || isMp4(b) || ascii(b, 0, 'ID3'),
  'audio/ogg': (b) => ascii(b, 0, 'OggS'),
  'audio/flac': (b) => ascii(b, 0, 'fLaC'),
  'audio/x-flac': (b) => ascii(b, 0, 'fLaC'),
  'audio/webm': isEbml,
};

/** A text attachment is checked over its head only: a NUL byte there means it is not text. */
export const TEXT_SNIFF_BYTES = 8192;

/** Whether `bytes` are the content a (normalised) attachment MIME type claims; text types must carry no NUL in their head. */
export function attachmentContentMatches(mime: string, bytes: Buffer): boolean {
  const signature = ATTACHMENT_SIGNATURES[mime];
  return signature ? signature(bytes) : !bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/** Whether `bytes` are the audio container a (normalised) audio MIME type claims. */
export function audioContentMatches(mime: string, bytes: Buffer): boolean {
  const signature = AUDIO_SIGNATURES[mime];
  return !!signature && signature(bytes);
}

/** Strict UTF-8: true only when every byte sequence is valid (a BOM is tolerated, a lone surrogate or truncated sequence is not). */
export function isStrictUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
