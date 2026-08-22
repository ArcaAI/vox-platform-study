'use client';

import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * TASK-787 J-18 — a label is a DESCRIPTOR, so it renders at 400; a heading is a
 * TITLE and keeps 500. The Geometry Contract caps text at weights 400/500, which
 * had collapsed every `text-sm font-medium` section heading onto this primitive's
 * exact class string — a card header and a form label inside it were pixel-
 * identical. Differentiating here fixes all of them at once and preserves the
 * console's 12–14px density (bumping ~110 headings to `text-base` would not).
 * Call sites that genuinely want an emphasised label still pass `font-medium`.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-normal select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
