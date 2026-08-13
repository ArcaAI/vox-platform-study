/**
 * Container-header audio duration probe.
 *
 * WHY THIS EXISTS. The batch upload route must enforce "each recording at most
 * 60 minutes" BEFORE it writes to object storage or dispatches a worker job.
 * Duration is the requirement; file size is a proxy that does not track it (a
 * 60-minute 16 kHz mono WAV is ~115 MB, a 3-hour 64 kbps MP3 is ~86 MB), so the
 * route needs the real number.
 *
 * WHY NOT A LIBRARY. `music-metadata` — the obvious choice — is pure ESM from
 * v8 onward (`"type": "module"`), and `apps/api` compiles to CommonJS
 * (`@arcaai/config-ts/nestjs.json`). The remaining CJS line (7.x) has been
 * unmaintained for years. Pinning a stale parser, or loading ESM from CJS
 * through a `new Function('return import(...)')` hack, both cost more than the
 * one field we actually need.
 *
 * WHAT IT DOES. Reads the DECLARED duration out of the container header. No
 * decode, no subprocess, no full-file scan (the MP3 CBR path is arithmetic on
 * one frame header). Everything is bounds-checked and returns `null` rather
 * than throwing: this runs on attacker-supplied bytes.
 *
 * DISPATCH IS BY MAGIC BYTES, never by the client's `Content-Type` — a caller
 * can label any payload `audio/wav`.
 *
 * `null` means UNDECIDABLE, and the caller treats it as a rejection
 * (decided fail-closed): a duration that cannot be established is not
 * evidence that the recording is within the limit. Known `null` cases: a
 * live/streamed WebM whose `Duration` element was never written (common in
 * `MediaRecorder` output), a truncated header, and a zero-length recording.
 */

/** Sample rates addressed by the 4-bit ADTS index, in Hz. */
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** MPEG-1/2/2.5 Layer III bitrates (kbps) by version group and bitrate index. */
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Sample rates by MPEG version id (3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5). */
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * Duration of `buffer` in seconds, or `null` when the container does not state
 * one that can be read.
 *
 * @param buffer complete uploaded file bytes
 * @param _mimetype the client-declared type — accepted for call-site clarity and
 *   deliberately UNUSED for dispatch, so a mislabelled upload cannot pick the parser
 */
export function probeAudioDurationSeconds(buffer: Buffer, _mimetype?: string): number | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  try {
    const seconds = dispatch(buffer);
    // Reject 0, negatives, NaN and Infinity together: none is a usable measurement.
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds;
  } catch {
    // Malformed input must never take the upload route down with it.
    return null;
  }
}

function dispatch(buf: Buffer): number | null {
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return wavDuration(buf);
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return flacDuration(buf);
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return oggDuration(buf);
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return mp4Duration(buf);
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return matroskaDuration(buf);
  return mpegDuration(buf);
}

// ── RIFF / WAVE ─────────────────────────────────────────────────────────────
// duration = data-chunk bytes ÷ byte rate. Chunks are walked (never assumed at
// fixed offsets) because `LIST`/`fact` chunks legitimately precede `data`.

function wavDuration(buf: Buffer): number | null {
  let offset = 12;
  let byteRate = 0;
  let dataSize: number | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      // fmt layout: format(2) channels(2) sampleRate(4) byteRate(4) blockAlign(2) bits(2)
      byteRate = buf.readUInt32LE(body + 8);
      if (byteRate === 0) {
        // Some writers leave byteRate zero; recompute it from the fields that
        // define it. If those are zero too the file is undecidable.
        const channels = buf.readUInt16LE(body + 2);
        const sampleRate = buf.readUInt32LE(body + 4);
        const bitsPerSample = body + 16 <= buf.length ? buf.readUInt16LE(body + 14) : 0;
        byteRate = (sampleRate * channels * bitsPerSample) / 8;
      }
    } else if (id === 'data') {
      // The DECLARED size is authoritative: a 60-minute upload is measured from
      // its header, not by requiring the whole payload to be resident.
      dataSize = size;
      break;
    }

    // Chunks are word-aligned; a zero/absurd size would otherwise loop forever.
    const advance = 8 + size + (size % 2);
    if (advance <= 8) break;
    offset += advance;
  }

  if (!byteRate || dataSize === null) return null;
  return dataSize / byteRate;
}

// ── FLAC ────────────────────────────────────────────────────────────────────
// STREAMINFO packs sampleRate (20 bits), channels (3), bitsPerSample (5) and
// totalSamples (36) into one 64-bit field at body offset 10.

function flacDuration(buf: Buffer): number | null {
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf.readUInt8(offset);
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = buf.readUIntBE(offset + 1, 3);
    const body = offset + 4;

    if (type === 0) {
      if (body + 18 > buf.length) return null;
      const packed = buf.readBigUInt64BE(body + 10);
      const sampleRate = Number(packed >> BigInt(44));
      const totalSamples = Number(packed & ((BigInt(1) << BigInt(36)) - BigInt(1)));
      if (!sampleRate || !totalSamples) return null;
      return totalSamples / sampleRate;
    }

    if (isLast) return null;
    offset = body + length;
  }
  return null;
}

// ── Ogg (Vorbis / Opus) ─────────────────────────────────────────────────────
// The last page's granule position is the stream length in samples. Opus fixes
// the granule clock at 48 kHz regardless of the encoded rate; Vorbis states its
// rate in the identification header on the first page.

function oggDuration(buf: Buffer): number | null {
  const rate = oggSampleRate(buf);
  if (!rate) return null;

  // Scan backwards for the final page's capture pattern.
  for (let offset = buf.length - 14; offset >= 0; offset -= 1) {
    if (buf.readUInt32BE(offset) !== 0x4f676753) continue; // 'OggS'
    const granule = buf.readBigUInt64LE(offset + 6);
    if (granule === BigInt(0) || granule === BigInt('0xFFFFFFFFFFFFFFFF')) continue;
    return Number(granule) / rate;
  }
  return null;
}

function oggSampleRate(buf: Buffer): number | null {
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  const opus = head.indexOf('OpusHead', 0, 'ascii');
  if (opus >= 0) return 48000; // Opus granule positions are always 48 kHz.
  const vorbis = head.indexOf('vorbis', 0, 'ascii');
  // Identification header: 'vorbis' + version(4) + channels(1) + sampleRate(4).
  if (vorbis >= 0 && vorbis + 15 <= head.length) {
    const rate = head.readUInt32LE(vorbis + 11);
    return rate > 0 ? rate : null;
  }
  return null;
}

// ── ISO-BMFF (MP4 / M4A) ────────────────────────────────────────────────────
// `moov` → `mvhd` states a timescale and a duration in that timescale.

function mp4Duration(buf: Buffer): number | null {
  const moov = findAtom(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  const mvhd = findAtom(buf, moov.body, moov.end, 'mvhd');
  if (!mvhd) return null;

  const p = mvhd.body;
  if (p + 4 > buf.length) return null;
  const version = buf.readUInt8(p);

  if (version === 1) {
    if (p + 32 > buf.length) return null;
    const timescale = buf.readUInt32BE(p + 20);
    const duration = Number(buf.readBigUInt64BE(p + 24));
    return timescale ? duration / timescale : null;
  }

  if (p + 20 > buf.length) return null;
  const timescale = buf.readUInt32BE(p + 12);
  const duration = buf.readUInt32BE(p + 16);
  return timescale ? duration / timescale : null;
}

function findAtom(buf: Buffer, from: number, until: number, type: string): { body: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= until && offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit extended size.
      if (offset + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = until - offset; // extends to the end of its container
    }
    if (size < headerSize) return null;

    if (buf.subarray(offset + 4, offset + 8).toString('ascii') === type) {
      return { body: offset + headerSize, end: Math.min(offset + size, until) };
    }
    offset += size;
  }
  return null;
}

// ── Matroska / WebM ─────────────────────────────────────────────────────────
// Segment → Info → { TimecodeScale (ns, default 1e6), Duration (float, in
// TimecodeScale units) }. A live capture often omits Duration entirely, which
// is exactly the undecidable case the caller rejects.

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TIMECODE_SCALE = 0x2ad7b1;
const EBML_DURATION = 0x4489;

function matroskaDuration(buf: Buffer): number | null {
  const segment = findEbml(buf, 0, buf.length, EBML_SEGMENT);
  if (!segment) return null;
  const info = findEbml(buf, segment.body, segment.end, EBML_INFO);
  if (!info) return null;

  const durationEl = findEbml(buf, info.body, info.end, EBML_DURATION);
  if (!durationEl) return null;
  const width = durationEl.end - durationEl.body;
  const ticks = width === 4 ? buf.readFloatBE(durationEl.body) : width === 8 ? buf.readDoubleBE(durationEl.body) : null;
  if (ticks === null) return null;

  const scaleEl = findEbml(buf, info.body, info.end, EBML_TIMECODE_SCALE);
  const scaleNs = scaleEl ? readUIntSafe(buf, scaleEl.body, scaleEl.end - scaleEl.body) : 1_000_000;
  if (!scaleNs) return null;

  return (ticks * scaleNs) / 1e9;
}

/** Walk one EBML level looking for `wantedId`; descends nowhere on its own. */
function findEbml(buf: Buffer, from: number, until: number, wantedId: number): { body: number; end: number } | null {
  let offset = from;
  while (offset < until && offset < buf.length) {
    const id = readVint(buf, offset, true);
    if (!id) return null;
    const size = readVint(buf, offset + id.width, false);
    if (!size) return null;

    const body = offset + id.width + size.width;
    // An unknown-size element (all size bits set) runs to the end of its parent.
    const end = size.unknown ? until : Math.min(body + size.value, until);
    if (end < body) return null;

    if (id.value === wantedId) return { body, end };
    if (body >= end) return null; // no forward progress ⇒ malformed
    offset = end;
  }
  return null;
}

/**
 * EBML variable-length integer. IDs keep their length-marker bit (that is what
 * makes `0x1A45DFA3` the literal header id); sizes have it stripped.
 */
function readVint(buf: Buffer, offset: number, keepMarker: boolean): { value: number; width: number; unknown: boolean } | null {
  if (offset >= buf.length) return null;
  const first = buf.readUInt8(offset);
  if (first === 0) return null;

  let width = 1;
  let mask = 0x80;
  while (width <= 8 && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || offset + width > buf.length) return null;

  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < width; i += 1) {
    const byte = buf.readUInt8(offset + i);
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, width, unknown: !keepMarker && allOnes };
}

function readUIntSafe(buf: Buffer, offset: number, width: number): number | null {
  if (width <= 0 || width > 8 || offset + width > buf.length) return null;
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + buf.readUInt8(offset + i);
  return value;
}

// ── MPEG audio: MP3 frames and raw ADTS AAC ─────────────────────────────────

function mpegDuration(buf: Buffer): number | null {
  const start = skipId3(buf);
  const sync = findMpegSync(buf, start);
  if (sync === null) return null;

  // ADTS AAC shares the 0xFFF sync word; layer bits of 00 with the MPEG-4 id
  // distinguish it from MP3 (which is always layer 01 here).
  const header = buf.readUInt32BE(sync);
  const layer = (header >> 17) & 0x03;
  if (layer === 0) return adtsDuration(buf, sync);
  return mp3Duration(buf, sync);
}

/** ID3v2 prefixes are not audio; their synchsafe size says how much to skip. */
function skipId3(buf: Buffer): number {
  if (buf.length < 10 || buf.subarray(0, 3).toString('ascii') !== 'ID3') return 0;
  const size = ((buf.readUInt8(6) & 0x7f) << 21) | ((buf.readUInt8(7) & 0x7f) << 14) | ((buf.readUInt8(8) & 0x7f) << 7) | (buf.readUInt8(9) & 0x7f);
  return Math.min(10 + size, buf.length);
}

function findMpegSync(buf: Buffer, from: number): number | null {
  // Bounded scan: a valid frame starts within the first few KB of audio data,
  // and an unbounded search over a 250 MB upload is a DoS surface.
  const limit = Math.min(buf.length - 4, from + 64 * 1024);
  for (let i = from; i <= limit; i += 1) {
    if (buf.readUInt8(i) === 0xff && (buf.readUInt8(i + 1) & 0xe0) === 0xe0) return i;
  }
  return null;
}

function mp3Duration(buf: Buffer, sync: number): number | null {
  const header = buf.readUInt32BE(sync);
  const versionId = (header >> 19) & 0x03;
  const bitrateIndex = (header >> 12) & 0x0f;
  const sampleRateIndex = (header >> 10) & 0x03;

  const sampleRates = MP3_SAMPLE_RATES[versionId];
  if (!sampleRates || sampleRateIndex === 3) return null;
  const sampleRate = sampleRates[sampleRateIndex];
  if (!sampleRate) return null;

  const samplesPerFrame = versionId === 3 ? 1152 : 576;

  // VBR headers state the exact frame count — always preferred over arithmetic.
  const xing = findXingFrameCount(buf, sync);
  if (xing !== null) return (xing * samplesPerFrame) / sampleRate;

  const bitrates = versionId === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2;
  const kbps = bitrates[bitrateIndex];
  if (!kbps) return null; // index 0 = "free", index 15 = invalid
  return ((buf.length - sync) * 8) / (kbps * 1000);
}

/** `Xing`/`Info` (and Fraunhofer `VBRI`) carry the total frame count. */
function findXingFrameCount(buf: Buffer, sync: number): number | null {
  const window = buf.subarray(sync, Math.min(buf.length, sync + 200));
  for (const tag of ['Xing', 'Info']) {
    const at = window.indexOf(tag, 0, 'ascii');
    if (at >= 0 && sync + at + 12 <= buf.length) {
      const flags = buf.readUInt32BE(sync + at + 4);
      if ((flags & 0x01) !== 0) return buf.readUInt32BE(sync + at + 8);
    }
  }
  const vbri = window.indexOf('VBRI', 0, 'ascii');
  if (vbri >= 0 && sync + vbri + 18 <= buf.length) return buf.readUInt32BE(sync + vbri + 14);
  return null;
}

/**
 * Raw ADTS: every frame is 1024 samples and declares its own length, so the
 * count is a walk of frame headers — no decode. The walk is bounded so a
 * crafted file cannot spin.
 */
function adtsDuration(buf: Buffer, start: number): number | null {
  const sampleRate = ADTS_SAMPLE_RATES[(buf.readUInt8(start + 2) >> 2) & 0x0f];
  if (!sampleRate) return null;

  let offset = start;
  let frames = 0;
  const MAX_FRAMES = 2_000_000; // ≈ 12 h at 44.1 kHz — far past any real upload
  while (offset + 7 <= buf.length && frames < MAX_FRAMES) {
    if (buf.readUInt8(offset) !== 0xff || (buf.readUInt8(offset + 1) & 0xf0) !== 0xf0) break;
    const frameLength = ((buf.readUInt8(offset + 3) & 0x03) << 11) | (buf.readUInt8(offset + 4) << 3) | ((buf.readUInt8(offset + 5) >> 5) & 0x07);
    if (frameLength < 7) break;
    offset += frameLength;
    frames += 1;
  }

  if (frames === 0) return null;
  return (frames * 1024) / sampleRate;
}
