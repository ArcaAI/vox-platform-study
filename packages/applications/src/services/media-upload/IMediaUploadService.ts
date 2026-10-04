import { MediaUploadResponse } from './dto';

/** TASK-1038 (F1) — which allow-list and ceiling an upload is held to. */
export type MediaUploadCategory = 'attachment' | 'audio';

export interface MediaUploadInput {
  category: MediaUploadCategory;
  buffer: Buffer;
  /** The client-declared MIME type; normalised and checked against the category. */
  mimeType: string;
  /** The client's file name — sanitised to a safe basename before it is used anywhere. */
  originalName?: string;
}

export interface IMediaUploadService {
  /** Store one file in the tenant's own bucket and record it as a `Media` row. */
  upload(input: MediaUploadInput): Promise<MediaUploadResponse>;
  /** This tenant's Media row as a reference; another tenant's or an unknown id is the same 404. */
  getOwnedReference(mediaId: string): Promise<MediaUploadResponse>;
}

export const IMediaUploadService = Symbol('IMediaUploadService');
