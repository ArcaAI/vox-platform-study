'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { Check, ChevronDown } from 'lucide-react';

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
  selected?: boolean;
  onSelect?: (id: string) => void;
  actions?: (item: TimelineItemModel) => React.ReactNode;
  onMediaOpen?: (itemId: string, index: number) => void;
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function TimelineItem({ item, expanded, density, lazyMedia, posInSet, setSize, resolveRenderer, onToggle, selected = false, onSelect, actions, onMediaOpen }: TimelineItemProps) {
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
      data-selected={onSelect ? selected : undefined}
      className={cn(
        'border-b last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        density === 'compact' ? 'px-3 py-2' : 'px-4 py-3',
        selected && 'bg-accent/50',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => onToggle(item.id)}
          aria-expanded={expanded}
          aria-controls={expanded ? contentId : undefined}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title ?? 'item'}`}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(item.id)}
            aria-pressed={selected}
            aria-label={`Select ${title ?? 'item'}`}
            data-slot="timeline-item-select"
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              selected && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            <Check aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        {actions ? (
          <div data-slot="timeline-item-actions" className="flex shrink-0 items-center gap-1">
            {actions(item)}
          </div>
        ) : null}
      </div>

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
