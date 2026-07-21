import type { TimelineContentVariant, TimelineRenderer } from '../types';

import { AudioRenderer } from './audio-renderer';
import { CustomRenderer, FallbackRenderer } from './fallback';
import { FileRenderer } from './file-renderer';
import { ImageGridRenderer } from './image-grid-renderer';
import { MarkdownRenderer } from './markdown-renderer';
import { MixedRenderer } from './mixed-renderer';
import { PdfRenderer } from './pdf-renderer';

/** Default per-variant renderer registry. */
export const DEFAULT_RENDERERS: Record<TimelineContentVariant, TimelineRenderer> = {
  markdown: MarkdownRenderer,
  pdf: PdfRenderer,
  image: ImageGridRenderer,
  audio: AudioRenderer,
  file: FileRenderer,
  mixed: MixedRenderer,
  custom: CustomRenderer,
};

/** Resolve a renderer for a variant: consumer override → default → fallback. */
export function resolveRenderer(
  variant: TimelineContentVariant,
  overrides?: Partial<Record<TimelineContentVariant, TimelineRenderer>>,
): TimelineRenderer {
  return overrides?.[variant] ?? DEFAULT_RENDERERS[variant] ?? FallbackRenderer;
}
