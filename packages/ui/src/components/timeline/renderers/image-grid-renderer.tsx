'use client';

import { ImageGallery } from '@/components/registries/tool-ui/image-gallery';

import type { TimelineRendererProps } from '../types';

/**
 * Image content renderer (thin wrapper over tool-ui `ImageGallery` =
 * grid + focus-trapped lightbox). `onMediaOpen` fires with the clicked index.
 */
export function ImageGridRenderer({ item, content, onMediaOpen }: TimelineRendererProps) {
  if (content.type !== 'image') return null;
  const images = content.images;
  return (
    <div data-slot="timeline-image-grid">
      <ImageGallery
        id={item.id}
        images={images}
        className="max-w-none"
        onImageClick={(imageId) => {
          const index = images.findIndex((img) => img.id === imageId);
          if (index >= 0) onMediaOpen?.(index);
        }}
      />
    </div>
  );
}
