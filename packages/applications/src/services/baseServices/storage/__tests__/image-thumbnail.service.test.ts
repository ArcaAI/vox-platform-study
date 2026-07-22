/**
 * (thumbnails) — real downscaled image derivatives.
 *
 * `ImageThumbnailService.generateWebpThumbnail` must turn an uploaded image into
 * a genuinely smaller WebP derivative (bounded by THUMBNAIL_MAX_DIMENSION, aspect
 * ratio preserved, never upscaled). The pure helpers `deriveThumbnailKey` /
 * `isThumbnailableImageMimeType` encode the by-convention derived-key scheme so
 * the upload (write) and the context timeline (read) agree without any DB column.
 *
 * These tests exercise REAL sharp output (create an input image → resize → read
 * the resulting metadata) rather than mocking the codec.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ImageThumbnailService,
  THUMBNAIL_KEY_SUFFIX,
  THUMBNAIL_MAX_DIMENSION,
  deriveThumbnailKey,
  isThumbnailableImageMimeType,
} from '../image-thumbnail.service';

describe('deriveThumbnailKey (thumbnails)', () => {
  it('appends the deterministic .thumb.webp suffix to the original key', () => {
    expect(deriveThumbnailKey('path/img.png')).toBe(`path/img.png${THUMBNAIL_KEY_SUFFIX}`);
    expect(deriveThumbnailKey('img.png')).toBe('img.png.thumb.webp');
  });

  it('is deterministic and idempotent for the same input', () => {
    expect(deriveThumbnailKey('a/b/c.jpg')).toBe(deriveThumbnailKey('a/b/c.jpg'));
  });
});

describe('isThumbnailableImageMimeType (thumbnails)', () => {
  it('accepts raster image mime types', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/tiff']) {
      expect(isThumbnailableImageMimeType(m)).toBe(true);
    }
  });

  it('rejects non-images, svg, and missing mime types', () => {
    for (const m of ['application/pdf', 'audio/wav', 'video/mp4', 'image/svg+xml', '', undefined, null]) {
      expect(isThumbnailableImageMimeType(m)).toBe(false);
    }
  });
});

describe('ImageThumbnailService.generateWebpThumbnail (thumbnails)', () => {
  const service = new ImageThumbnailService();

  it('downscales a large image to a WebP bounded by the max dimension, preserving aspect ratio', async () => {
    const input = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const output = await service.generateWebpThumbnail(input);

    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(THUMBNAIL_MAX_DIMENSION); // 800 → 320
    expect(meta.height).toBe(240); // 600 scaled with the same factor
    // A real derivative is materially smaller than the source bytes.
    expect(output.length).toBeLessThan(input.length);
  });

  it('does NOT upscale an image already smaller than the max dimension', async () => {
    const input = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();

    const output = await service.generateWebpThumbnail(input);

    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it('rejects (throws) on non-image bytes so the caller can degrade best-effort', async () => {
    await expect(service.generateWebpThumbnail(Buffer.from('not an image'))).rejects.toBeTruthy();
  });
});
