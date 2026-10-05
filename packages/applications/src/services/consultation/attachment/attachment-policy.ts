import { MEDIA_AUDIO_MIME_TYPES } from '../../media-upload/media-content-sniff';

/** The four things a clinician can hand a consultation outside the live stream. */
export const ATTACHMENT_KINDS = ['document', 'image', 'audio', 'case_note'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_PURPOSES = ['attachment', 'feedback'] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

/** `uploadUrl` is null for a gateway upload (the client posts the bytes to `/content`). */
export const ATTACHMENT_UPLOAD_MODES = ['presigned', 'gateway'] as const;
export type AttachmentUploadMode = (typeof ATTACHMENT_UPLOAD_MODES)[number];

export const ATTACHMENT_STATUSES = ['INTENT', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export const ATTACHMENT_ERROR_CODES = {
  TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  TYPE_UNSUPPORTED: 'ATTACHMENT_TYPE_UNSUPPORTED',
  CONTENT_MISMATCH: 'ATTACHMENT_CONTENT_MISMATCH',
  KIND_UNSUPPORTED: 'ATTACHMENT_KIND_UNSUPPORTED',
  CHECKSUM_MISMATCH: 'ATTACHMENT_CHECKSUM_MISMATCH',
  NOT_UPLOADED: 'ATTACHMENT_NOT_UPLOADED',
  INTENT_EXPIRED: 'ATTACHMENT_INTENT_EXPIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_IN_FLIGHT: 'IDEMPOTENCY_KEY_IN_FLIGHT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  CONSULTATION_APPROVED: 'CONSULTATION_APPROVED',
  CONSULTATION_CLOSED: 'CONSULTATION_CLOSED',
  MEDIA_STORAGE_UNAVAILABLE: 'MEDIA_STORAGE_UNAVAILABLE',
} as const;
export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[keyof typeof ATTACHMENT_ERROR_CODES];

/** A refusal the policy decided; the service maps `httpStatus` + `code` onto the HTTP exception. */
export class AttachmentPolicyError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    readonly httpStatus: 413 | 415 | 422,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AttachmentPolicyError';
  }
}

/**
 * The MIME types each kind accepts. A `document` is a PDF or text; a `case_note` is plain text that
 * becomes a case-note context item; audio is the one shared media audio allow-list.
 */
export const ATTACHMENT_KIND_MIME_TYPES: Readonly<Record<AttachmentKind, ReadonlySet<string>>> = {
  document: new Set(['application/pdf', 'text/plain', 'text/markdown']),
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  audio: MEDIA_AUDIO_MIME_TYPES,
  case_note: new Set(['text/plain']),
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
};

/** Lower-cased, trimmed, `image/jpg` → `image/jpeg`, parameters (`; charset=…`) dropped. */
export function normalizeAttachmentMime(value: string): string {
  const base = (value ?? '').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

export function isMimeAllowedForKind(kind: AttachmentKind, mime: string): boolean {
  return ATTACHMENT_KIND_MIME_TYPES[kind].has(normalizeAttachmentMime(mime));
}

/** The file extension stored for a MIME type; empty for one outside every allow-list. */
export function attachmentExtension(mime: string): string {
  return EXTENSIONS[normalizeAttachmentMime(mime)] ?? '';
}

/** The ceilings, in MB, read from the settings plane by the caller — never literals here. */
export interface AttachmentSizeSettings {
  /** `media.upload.maxAttachmentSizeMb` — document, image, case note. */
  readonly maxAttachmentSizeMb: number;
  /** `media.upload.maxAudioSizeMb`. */
  readonly maxAudioSizeMb: number;
  /** `stt.batch.maxFileSizeMb` — audio is transcribed through the batch path, so it also bounds the upload. */
  readonly batchMaxFileSizeMb: number;
}

const MB = 1024 * 1024;

/** The byte ceiling for one kind: audio is bounded by the tighter of the media and batch limits. */
export function resolveMaxSizeBytes(kind: AttachmentKind, settings: AttachmentSizeSettings): number {
  const mb = kind === 'audio' ? Math.min(settings.maxAudioSizeMb, settings.batchMaxFileSizeMb) : settings.maxAttachmentSizeMb;
  return Math.floor(mb * MB);
}

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface AttachmentObjectKeyInput {
  readonly consultationId: string;
  readonly attachmentId: string;
  readonly mime: string;
  readonly purpose: AttachmentPurpose;
  readonly now: Date;
}

/**
 * `consultations/{yyyy}/{MM}/{consultationId}/{attachments|feedback}/{attachmentId}/{attachmentId}.{ext}`.
 * Ids only — a client file name is PHI-prone and never part of a key.
 */
export function buildAttachmentObjectKey(input: AttachmentObjectKeyInput): string {
  if (!SAFE_ID.test(input.consultationId) || !SAFE_ID.test(input.attachmentId)) {
    throw new Error('An attachment object key is built from ids only.');
  }
  const yyyy = String(input.now.getUTCFullYear());
  const MM = String(input.now.getUTCMonth() + 1).padStart(2, '0');
  const folder = input.purpose === 'feedback' ? 'feedback' : 'attachments';
  const ext = attachmentExtension(input.mime);
  const file = ext ? `${input.attachmentId}.${ext}` : input.attachmentId;
  return `consultations/${yyyy}/${MM}/${input.consultationId}/${folder}/${input.attachmentId}/${file}`;
}

/** The loop-config subscriptions that unlock extraction under a governing workflow. */
export const DOCUMENT_EXTRACT_SUBSCRIPTION = 'document.extract_text';
export const IMAGE_EXTRACT_SUBSCRIPTION = 'vision.extract_text';

export interface SupportedKindsInput {
  /** `AsrAgentResolverService.resolve` succeeded for the consultation. */
  readonly asrResolvable: boolean;
  /** A governing workflow owns the consultation's note engine. */
  readonly governed: boolean;
  /** The `ILoopConfigService` subscriptions in force. */
  readonly subscriptions: readonly string[];
}

/**
 * What this consultation can accept right now. `case_note` always; `audio` iff an ASR agent
 * resolves; `document` on the default engine (PDF text extraction) or, under a governing workflow,
 * only when it subscribes to `document.extract_text`; `image` only with `vision.extract_text`.
 */
export function deriveSupportedKinds(input: SupportedKindsInput): AttachmentKind[] {
  const subscribed = new Set(input.subscriptions);
  const supported: AttachmentKind[] = [];
  if (!input.governed || subscribed.has(DOCUMENT_EXTRACT_SUBSCRIPTION)) supported.push('document');
  if (subscribed.has(IMAGE_EXTRACT_SUBSCRIPTION)) supported.push('image');
  if (input.asrResolvable) supported.push('audio');
  supported.push('case_note');
  return supported;
}

/** 422 `ATTACHMENT_KIND_UNSUPPORTED` carrying the kinds that would have been accepted. */
export function assertKindSupported(kind: AttachmentKind, supportedKinds: readonly AttachmentKind[]): void {
  if (supportedKinds.includes(kind)) return;
  throw new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.KIND_UNSUPPORTED, 422, `This consultation cannot take a '${kind}' attachment.`, {
    supportedKinds: [...supportedKinds],
  });
}

export interface AttachmentIntentCheck {
  readonly kind: AttachmentKind;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly supportedKinds: readonly AttachmentKind[];
  readonly sizes: AttachmentSizeSettings;
}

/** The intent-time refusals in contract order: kind (422), type (415), size (413). Returns the normalised MIME. */
export function validateIntent(input: AttachmentIntentCheck): { mime: string; maxSizeBytes: number } {
  assertKindSupported(input.kind, input.supportedKinds);
  const mime = normalizeAttachmentMime(input.mime);
  if (!isMimeAllowedForKind(input.kind, mime)) {
    throw new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.TYPE_UNSUPPORTED, 415, `A '${input.kind}' attachment cannot be '${mime || 'untyped'}'.`, {
      allowedMimeTypes: [...ATTACHMENT_KIND_MIME_TYPES[input.kind]],
    });
  }
  const maxSizeBytes = resolveMaxSizeBytes(input.kind, input.sizes);
  if (input.sizeBytes > maxSizeBytes) {
    throw new AttachmentPolicyError(
      ATTACHMENT_ERROR_CODES.TOO_LARGE,
      413,
      `The file is ${input.sizeBytes} bytes; the maximum for a '${input.kind}' is ${maxSizeBytes}.`,
      { maxSizeBytes },
    );
  }
  return { mime, maxSizeBytes };
}
