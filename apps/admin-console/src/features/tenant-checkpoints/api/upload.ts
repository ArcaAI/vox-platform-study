/**
 * Browser multipart driver for an uploaded checkpoint. Pure over `putPart`, so
 * it is testable without a network. The object store must expose the `ETag`
 * response header to the console origin (CORS `ExposeHeaders`); without it the
 * upload cannot be completed and the driver says so by name.
 */

import type { CompletedPart, UploadPartTarget } from './types';

export interface PartResponse {
  headers: { get(name: string): string | null };
}

export type PutPart = (url: string, blob: Blob, signal?: AbortSignal) => Promise<PartResponse>;

export interface UploadOptions {
  signal?: AbortSignal;
  /** Called after each part finishes with (partsDone, partsTotal). */
  onProgress?: (done: number, total: number) => void;
}

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

function abortError(): Error {
  const error = new Error('Upload aborted');
  error.name = 'AbortError';
  return error;
}

/** Default transport: a plain PUT of the part body straight to the presigned URL. */
export const putPartViaFetch: PutPart = async (url, blob, signal) => {
  const response = await fetch(url, { method: 'PUT', body: blob, signal });
  if (!response.ok) throw new UploadError('UPLOAD_PART_FAILED', `Part upload failed with status ${response.status}`);
  return response;
};

export async function uploadInParts(
  file: Blob,
  init: { partSizeBytes: number; parts: UploadPartTarget[] },
  putPart: PutPart,
  { signal, onProgress }: UploadOptions = {},
): Promise<CompletedPart[]> {
  const targets = [...init.parts].sort((a, b) => a.partNumber - b.partNumber);
  const completed: CompletedPart[] = [];
  for (const [index, target] of targets.entries()) {
    if (signal?.aborted) throw abortError();
    const start = (target.partNumber - 1) * init.partSizeBytes;
    const response = await putPart(target.url, file.slice(start, start + init.partSizeBytes), signal);
    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new UploadError('UPLOAD_ETAG_MISSING', 'The storage endpoint did not expose the ETag header. Its CORS policy must expose ETag to this origin.');
    }
    completed.push({ partNumber: target.partNumber, etag });
    onProgress?.(index + 1, targets.length);
  }
  return completed;
}
