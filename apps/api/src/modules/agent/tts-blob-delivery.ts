import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY } from '@arcaai/applications';
import type { IBlobStorageService, IMediaService, ITenantBucketService, TenantSettingsService } from '@arcaai/applications';
import { TenantBucketPurpose, generateId } from '@arcaai/domains';

/** TASK-1036 §3.2 — the TTS formats a blob may carry. */
export type SpeechBlobFormat = 'wav' | 'mp3' | 'pcm' | 'ogg';

const MIME: Readonly<Record<SpeechBlobFormat, string>> = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'audio/pcm',
  ogg: 'audio/ogg',
});

/** What `POST /agents/:slug/speech` answers with `delivery: 'blob'`. */
export interface SpeechBlobResponse {
  mediaId: string;
  /** A signed GET URL, valid until `expiresAt` (`workflowRuns.resultUrlTtlSeconds`). */
  url: string;
  expiresAt: string;
  format: SpeechBlobFormat;
  sampleRate: number | null;
  durationMs: number | null;
}

export interface SpeechBlobDeps {
  blobStorage: Pick<IBlobStorageService, 'putObject' | 'presignGet'>;
  tenantBuckets: Pick<ITenantBucketService, 'getBucketByPurpose' | 'getBucketBySlug'>;
  media: Pick<IMediaService, 'create'>;
  settings?: Pick<TenantSettingsService, 'resolvePlatform'>;
}

export interface PersistSpeechBlobInput {
  tenantId: string;
  agentSlug: string;
  audio: Buffer;
  format: SpeechBlobFormat;
  /** What `apps/tts` reported (`X-Tts-Sample-Rate`), else the agent's parameter; `null` = unknown. */
  sampleRate: number | null;
  /** What `apps/tts` reported (`X-Tts-Audio-Seconds`); `null` = derive it where the format allows. */
  durationMs: number | null;
}

/** `{ sampleRate, channels, bitsPerSample, dataBytes }` of a RIFF/WAVE buffer, or `null`. */
function wavInfo(audio: Buffer): { sampleRate: number; channels: number; bitsPerSample: number; dataBytes: number } | null {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= audio.length) {
      fmt = {
        channels: audio.readUInt16LE(offset + 10),
        sampleRate: audio.readUInt32LE(offset + 12),
        bitsPerSample: audio.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      if (!fmt) return null;
      // A streamed WAV may carry a placeholder size; the bytes actually present are the truth.
      const dataBytes = Math.min(size, audio.length - offset - 8);
      return { ...fmt, dataBytes };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * The duration of synthesised audio where the bytes say it exactly: a WAV header, or raw PCM16
 * mono at a known rate (the TTS `pcm` format). A compressed format is never estimated — `null`.
 */
export function speechDurationMs(audio: Buffer, format: SpeechBlobFormat, sampleRate: number | null): number | null {
  if (format === 'wav') {
    const info = wavInfo(audio);
    if (!info || info.sampleRate <= 0 || info.channels <= 0 || info.bitsPerSample <= 0) return null;
    return Math.round((info.dataBytes / (info.sampleRate * info.channels * (info.bitsPerSample / 8))) * 1000);
  }
  if (format === 'pcm' && sampleRate !== null && sampleRate > 0) return Math.round((audio.length / (sampleRate * 2)) * 1000);
  return null;
}

/**
 * TASK-1036 §3.2 — store one synthesis in the tenant's AUDIO bucket and hand back a short-lived
 * signed URL to it, with the `Media` row that records it.
 *
 * The bucket is the tenant's own (purpose AUDIO, else the conventional `recordings` / `audio`
 * slugs — the same cascade the batch-transcription upload uses). A tenant with none is a named
 * 503: synthesised speech is PHI-adjacent, and writing it to a platform bucket the tenant did not
 * configure would be a worse answer than refusing.
 */
export async function persistSpeechBlob(deps: SpeechBlobDeps, input: PersistSpeechBlobInput): Promise<SpeechBlobResponse> {
  const bucket =
    (await deps.tenantBuckets.getBucketByPurpose(TenantBucketPurpose.AUDIO)) ??
    (await deps.tenantBuckets.getBucketBySlug('recordings')) ??
    (await deps.tenantBuckets.getBucketBySlug('audio'));
  if (!bucket) {
    throw new ServiceUnavailableException({
      code: 'TTS_BLOB_STORAGE_UNAVAILABLE',
      message: 'This tenant has no audio bucket to store synthesised speech in. Configure one (purpose AUDIO), or request the streamed delivery.',
    });
  }

  const now = new Date();
  const objectId = generateId();
  const extension = input.format;
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/tts/${input.agentSlug}/${objectId}.${extension}`;
  const mimeType = MIME[input.format];
  await deps.blobStorage.putObject({ bucket: bucket.name, key, body: input.audio, contentType: mimeType });

  const media = await deps.media.create({
    tenantId: input.tenantId,
    name: `${input.agentSlug}-${objectId}.${extension}`,
    uri: `s3://${bucket.name}/${key}`,
    extension,
    mimeType,
    size: input.audio.length,
    hash: createHash('sha256').update(input.audio).digest('hex'),
  } as never);

  const ttlSeconds = urlTtlSeconds(deps.settings);
  const issuedAt = Date.now();
  const url = await deps.blobStorage.presignGet({ bucket: bucket.name, key, expiresInSeconds: ttlSeconds });

  const wav = input.format === 'wav' ? wavInfo(input.audio) : null;
  const sampleRate = input.sampleRate ?? wav?.sampleRate ?? null;
  return {
    mediaId: String(media.id),
    url,
    expiresAt: new Date(issuedAt + ttlSeconds * 1000).toISOString(),
    format: input.format,
    sampleRate,
    durationMs: input.durationMs ?? speechDurationMs(input.audio, input.format, sampleRate),
  };
}

/** `workflowRuns.resultUrlTtlSeconds` — the delivery plane's ONE signed-URL lifetime (TASK-1038). */
function urlTtlSeconds(settings: SpeechBlobDeps['settings']): number {
  try {
    const value = settings?.resolvePlatform<number>(WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY).value;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.resultUrlTtlSeconds;
  } catch {
    return WORKFLOW_RUNS_DEFAULTS.resultUrlTtlSeconds;
  }
}
