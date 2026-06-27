'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { ChevronDown } from 'lucide-react';

import { Badge } from '@/components/shadcn/badge';
import type { Density } from '@/lib/shared';
import { cn } from '@/lib/utils';

import type { TimelineContentVariant, TimelineItemModel, TimelineRenderer } from './types';

export interface TimelineItemProps {
  item: TimelineItemModel;
  expanded: boolean;
  density: Density;
  lazyMedia: boolean;
  posInSet: number;
  setSize: number;
  resolveRenderer: (variant: TimelineContentVariant) => TimelineRenderer;
  onToggle: (id: string) => void;
  onMediaOpen?: (itemId: string, index: number) => void;
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function TimelineItem({ item, expanded, density, lazyMedia, posInSet, setSize, resolveRenderer, onToggle, onMediaOpen }: TimelineItemProps) {
  const Renderer = resolveRenderer(item.variant);
  const headingId = `timeline-item-${item.id}-title`;
  const contentId = `timeline-item-${item.id}-content`;
  const date = toDate(item.timestamp);
  const title = typeof item.title === 'string' ? item.title : undefined;

  return (
    <article
      tabIndex={0}
      aria-labelledby={headingId}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      data-slot="timeline-item"
      data-density={density}
      className={cn(
        'border-b last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        density === 'compact' ? 'px-3 py-2' : 'px-4 py-3',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(item.id)}
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title ?? 'item'}`}
        className="flex w-full items-start gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span id={headingId} className="truncate text-sm font-medium text-foreground">
              {item.title ?? 'Untitled'}
            </span>
            {item.badges?.map((badge, i) => (
              <Badge key={i} variant={badge.variant ?? 'secondary'} className="gap-1">
                {badge.icon}
                {badge.label}
              </Badge>
            ))}
          </div>
          {date ? (
            <time className="text-xs text-muted-foreground" dateTime={date.toISOString()}>
              {format(date, 'PP p')}
            </time>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div id={contentId} data-slot="timeline-item-content" className="mt-3 pl-7">
          {Renderer({
            item,
            content: item.content,
            expanded,
            density,
            lazyMedia,
            onMediaOpen: onMediaOpen ? (index) => onMediaOpen(item.id, index) : undefined,
          })}
        </div>
      ) : null}
    </article>
  );
}
