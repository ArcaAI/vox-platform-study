import { AttachmentIntentResponse, AttachmentResponse, CreateAttachmentIntentRequest } from './dto';

/** One multipart file as the gateway received it. */
export interface AttachmentContentUpload {
  buffer: Buffer;
  /** Informational only: the intent's declared MIME type is what the bytes are checked against. */
  mimeType?: string;
}

/**
 * Files handed to a consultation outside the live stream: intent → PUT (presigned, or the gateway
 * `content` route) → complete. Every method resolves the consultation inside the caller's tenant
 * (404 otherwise). `complete` / `uploadContent` answer `status: 'PROCESSING'` when the work goes on
 * in the background (audio transcription, or a large object verified asynchronously) — the
 * controller maps that to 202, anything else to 200.
 */
export abstract class IConsultationAttachmentService {
  abstract createIntent(consultationId: string, request: CreateAttachmentIntentRequest, idempotencyKey?: string): Promise<AttachmentIntentResponse>;
  abstract complete(consultationId: string, attachmentId: string): Promise<AttachmentResponse>;
  abstract uploadContent(consultationId: string, attachmentId: string, file: AttachmentContentUpload): Promise<AttachmentResponse>;
  abstract list(consultationId: string): Promise<AttachmentResponse[]>;
  abstract get(consultationId: string, attachmentId: string): Promise<AttachmentResponse>;
}

export const IConsultationAttachmentServiceToken = Symbol('IConsultationAttachmentService');
