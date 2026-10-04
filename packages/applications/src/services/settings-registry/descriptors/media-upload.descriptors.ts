// TASK-1038 (F1) — tenant media upload (`POST /media`) size ceilings.
//
// WHY `global-kv` + `globalOnly` + `maxScope: 'system'`: the same reasoning as the batch-transcription
// ceilings (`batch-transcription.descriptors.ts`). These bound how much one request may push into
// object storage and through the gateway's memory — platform capacity, not a tenant preference.
// WHY `open-to-default`: a missing `GlobalSetting` row degrades to the code defaults, never to a
// refused upload; nothing here SELECTS anything, so the fail-closed rule does not apply.

import { SettingDescriptor } from '../registry.types';

export const MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY = 'media.upload.maxAttachmentSizeMb';
export const MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY = 'media.upload.maxAudioSizeMb';

/**
 * The static multipart ceiling the upload route's interceptor applies (a decorator cannot read a
 * setting). It only stops a body far beyond any configured limit from being buffered; the
 * configured ceilings below are enforced in the service and may not exceed it.
 */
export const MEDIA_UPLOAD_HARD_CEILING_MB = 1024;

export const MEDIA_UPLOAD_DEFAULTS = {
  /** A document or image attachment (text, Markdown, PDF, JPEG, PNG, WebP). */
  maxAttachmentSizeMb: 25,
  /** An audio blob — the batch-transcription file ceiling (`stt.batch.maxFileSizeMb`). */
  maxAudioSizeMb: 250,
} as const;

function wholeMegabytes(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'Must be a whole number of at least 1.';
  if (value > MEDIA_UPLOAD_HARD_CEILING_MB) return `Must not exceed ${MEDIA_UPLOAD_HARD_CEILING_MB} (the upload route's hard ceiling).`;
  return undefined;
}

const COMMON = {
  tier: 'global-kv',
  dataType: 'number',
  sensitivity: 'internal',
  maxScope: 'system',
  globalOnly: true,
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: 'Storage',
  validate: wholeMegabytes,
} as const;

export const MEDIA_UPLOAD_SETTINGS: SettingDescriptor[] = [
  {
    ...COMMON,
    key: MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY,
    label: 'Media upload — max attachment size (MB)',
    description: 'Size ceiling for one document or image uploaded through POST /media (an attachment a run references by mediaId).',
    default: MEDIA_UPLOAD_DEFAULTS.maxAttachmentSizeMb,
  },
  {
    ...COMMON,
    key: MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY,
    label: 'Media upload — max audio size (MB)',
    description: 'Size ceiling for one audio file uploaded through POST /media (an audio blob a run references by mediaId).',
    default: MEDIA_UPLOAD_DEFAULTS.maxAudioSizeMb,
  },
];
