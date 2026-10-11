import { FileTypeValidator, FileValidator } from '@nestjs/common';

/** Nest's `IFile` (not exported from `@nestjs/common`'s public entry). */
type UploadedFileLike = NonNullable<Parameters<FileTypeValidator['isValid']>[0]>;

/**
 * BUG-028 — the enrollment-sample type check.
 *
 * `FileTypeValidator` judges the magic-number-sniffed type, and `file-type` reports every
 * WebM/MP4 container as `video/*` — it cannot tell an audio-only one apart. Browser
 * MediaRecorder output is exactly that (Chrome `audio/webm`, Safari `audio/mp4`), so a plain
 * `/^audio\//` refused every in-browser recording. Accepted (owner OD-1):
 *
 * - a file sniffed as `audio/*`, whatever the client declared;
 * - a file sniffed as a `video/webm` or `video/mp4` container ONLY when the client declared it
 *   `audio/*` — a renamed image still fails the sniff, and a real video upload is still refused.
 *
 * The embedding model's own decode stays the second gate.
 */
export class AudioUploadTypeValidator extends FileValidator {
  private readonly audioOrRecorderContainer = new FileTypeValidator({ fileType: /^(audio\/|video\/(webm|mp4)$)/ });
  private readonly sniffedAudio = new FileTypeValidator({ fileType: /^audio\// });

  constructor() {
    super({});
  }

  async isValid(file?: UploadedFileLike): Promise<boolean> {
    if (!(await this.audioOrRecorderContainer.isValid(file))) return false;
    if (await this.sniffedAudio.isValid(file)) return true;
    return typeof file?.mimetype === 'string' && file.mimetype.startsWith('audio/');
  }

  buildErrorMessage(file?: UploadedFileLike): string {
    return `Validation failed (expected an audio recording; current file type is ${file?.mimetype ?? 'unknown'})`;
  }
}
