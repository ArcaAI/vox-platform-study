/**
 * Test-tab attachments (TASK-1036 OD-15): a file is uploaded FIRST, to the tenant media store, and
 * the sandbox run is then started with `attachments: [{ mediaId }]` — the run body never carries
 * bytes. `POST /api/v1/media` is a multipart route (`file` field) answering the stored object's
 * identity; it is reached through the console's BFF proxy like every other gateway call, so it
 * lives with the Test tab (its only caller) rather than in `shared/sandbox`.
 */
import { postJson } from '@/shared/api';

/** `POST /api/v1/media` 201. */
export interface UploadedMedia {
  mediaId: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export function uploadMedia(file: File): Promise<UploadedMedia> {
  const form = new FormData();
  form.append('file', file);
  return postJson<UploadedMedia>('media', form);
}

/** Whether `mime` is allowed by the Input shape's list (`image/*` wildcards allowed; empty list = any). */
export function isAcceptedMime(mime: string, accepted: readonly string[]): boolean {
  if (accepted.length === 0) return true;
  return accepted.some((entry) => (entry.endsWith('/*') ? mime.startsWith(entry.slice(0, -1)) : entry === mime));
}
