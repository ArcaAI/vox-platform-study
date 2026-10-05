'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import type { TimelineBandModel } from './types';

const timelineBandVariants = cva('flex items-center gap-3 border-b px-4', {
  variants: {
    tone: {
      section: 'bg-muted/60 py-2 text-sm font-semibold text-foreground',
      gap: 'py-1.5 text-xs italic text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'section' },
});

export interface TimelineBandProps extends Omit<React.ComponentProps<'div'>, 'children'>, VariantProps<typeof timelineBandVariants> {
  band: TimelineBandModel;
}

function TimelineBand({ band, tone, className, ...props }: TimelineBandProps) {
  const resolvedTone = tone ?? band.tone ?? 'section';
  return (
    <div
      role="article"
      aria-label={band.label}
      data-slot="timeline-band"
      data-tone={resolvedTone}
      className={cn(timelineBandVariants({ tone: resolvedTone }), className)}
      {...props}
    >
      {/* A feed may only own articles (aria-required-children), so the band is an article whose
          accessible name is the label; everything inside is decorative and aria-hidden. */}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span aria-hidden="true" className="flex shrink-0 flex-col items-center">
        <span>{band.label}</span>
        {band.description ? <span className="text-xs font-normal text-muted-foreground">{band.description}</span> : null}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

export { TimelineBand, timelineBandVariants };
