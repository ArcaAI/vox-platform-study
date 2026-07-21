import { Injectable } from '@nestjs/common';

/**
 * Real downscaled image thumbnail derivatives for context-item media.
 *
 * `thumbnailUrl` previously returned the FULL-size presigned image URL. This
 * module produces a genuinely smaller derivative on upload and addresses it
 * by a DETERMINISTIC key convention so no schema change / DB column is needed:
 *
 *   original key  →  `<key>.thumb.webp`
 *
 * The upload path ({@link StorageController}) writes the derivative at this
 * derived key; the read path ({@link ContextService}) recomputes the same key,
 * confirms the object exists, and presigns it (falling back to the full-size URL
 * for pre-existing media that has no derivative). Both sides share
 * {@link deriveThumbnailKey} so the convention can never drift.
 */

/** Suffix appended to an image's storage key to address its WebP derivative. */
export const THUMBNAIL_KEY_SUFFIX = '.thumb.webp';

/** Longest edge (px) of a generated thumbnail; the other edge scales to fit. */
export const THUMBNAIL_MAX_DIMENSION = 320;

/** WebP quality (0–100). 70 keeps thumbnails small while staying legible. */
const THUMBNAIL_WEBP_QUALITY = 70;

/**
 * Derive the deterministic storage key of an image's thumbnail derivative from
 * its original key. Pure + idempotent; shared by the upload (write) and the
 * context timeline (read) so neither needs to persist the derived key.
 */
export function deriveThumbnailKey(key: string): string {
  return `${key}${THUMBNAIL_KEY_SUFFIX}`;
}

/**
 * Whether a derivative should be generated for the given MIME type. Only raster
 * images get thumbnails; `image/svg+xml` is excluded (vector, already tiny, and
 * needs librsvg) and non-image types never qualify.
 */
export function isThumbnailableImageMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
}

/**
 * Generates downscaled WebP thumbnails from image bytes via `sharp`. Stateless;
 * `sharp` is loaded lazily inside {@link generateWebpThumbnail} so importing the
 * storage barrel does not pull in the native binary unless a thumbnail is
 * actually produced.
 */
@Injectable()
export class ImageThumbnailService {
  /**
   * Resize `input` to fit within a {@link THUMBNAIL_MAX_DIMENSION} square
   * (aspect ratio preserved, never enlarged) and encode it as WebP. Auto-orients
   * via EXIF first. Throws on non-image / unsupported input so the caller can
   * degrade best-effort (the upload itself must never fail because of a missing
   * thumbnail).
   */
  async generateWebpThumbnail(input: Buffer): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp(input)
      .rotate()
      .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer();
  }
}
