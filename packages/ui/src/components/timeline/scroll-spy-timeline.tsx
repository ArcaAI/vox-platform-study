'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { ChevronDown, Inbox, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/empty';
import { Skeleton } from '@/components/shadcn/skeleton';
import { useExpansion, type AsyncStateProps, type BaseSurfaceProps, type Density } from '@/lib/shared';
import { cn } from '@/lib/utils';

import { resolveRenderer as resolveDefaultRenderer } from './renderers/registry';
import { useScrollSpy } from './use-scroll-spy';
import type { TimelineContent, TimelineContentVariant, TimelineItemModel, TimelineRenderer } from './types';

export interface TimelineMilestone {
  id: string;
  version?: string;
  date: string | Date;
  title: React.ReactNode;
  intro?: React.ReactNode;
  sections?: { id: string; label: string; defaultOpen?: boolean; content: TimelineContent }[];
  /** Reuses the existing timeline renderer registry. */
  media?: TimelineContent;
}

export interface ScrollSpyTimelineProps extends BaseSurfaceProps, AsyncStateProps {
  milestones: TimelineMilestone[];
  /** Input is newest-first by contract; only `asc` reorders. */
  order?: 'desc' | 'asc';
  /** Px from the top for the sticky active marker. */
  stickyOffset?: number;
  onActiveChange?: (id: string) => void;
  renderers?: Partial<Record<TimelineContentVariant, TimelineRenderer>>;
  onRetry?: () => void;
  'aria-label'?: string;
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

/** Resolve + render one `TimelineContent` block through the renderer registry. */
function RenderedContent({
  contentKey,
  timestamp,
  content,
  density,
  renderers,
}: {
  contentKey: string;
  timestamp: string | Date;
  content: TimelineContent;
  density: Density;
  renderers?: Partial<Record<TimelineContentVariant, TimelineRenderer>>;
}) {
  const Renderer = resolveDefaultRenderer(content.type, renderers);
  const item: TimelineItemModel = { id: contentKey, timestamp, variant: content.type, content };
  return <Renderer item={item} content={content} expanded density={density} lazyMedia />;
}

/**
 * Scroll-spy changelog timeline. A sticky marker rail tracks the
 * milestone currently in view (`useScrollSpy` + `IntersectionObserver`) while the
 * content column reuses the timeline renderer registry + `useExpansion` for the
 * collapsible New / Updates / Bug-Fixes sections. The rail is decorative; the
 * milestones are exposed as an accessible `<ol>`.
 */
export function ScrollSpyTimeline(props: ScrollSpyTimelineProps) {
  const {
    milestones,
    order = 'desc',
    stickyOffset = 0,
    onActiveChange,
    renderers,
    onRetry,
    density = 'comfortable',
    className,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
  } = props;
  const ariaLabel = props['aria-label'];

  const ordered = React.useMemo(() => (order === 'asc' ? [...milestones].reverse() : milestones), [milestones, order]);
  const ids = React.useMemo(() => ordered.map((m) => m.id), [ordered]);

  const reducedMotion = usePrefersReducedMotion();
  const { activeId, register } = useScrollSpy({ ids, offset: stickyOffset, onActiveChange });
  const effectiveActiveId = activeId ?? ordered[0]?.id ?? null;

  const defaultOpen = React.useMemo(
    () => ordered.flatMap((m) => (m.sections ?? []).filter((s) => s.defaultOpen).map((s) => `${m.id}:${s.id}`)),
    [ordered],
  );
  const sections = useExpansion({ defaultExpandedIds: defaultOpen });

  const wrapperProps = {
    'data-slot': 'scroll-spy-timeline',
    'data-density': density,
    'data-reduced-motion': reducedMotion ? 'true' : 'false',
    className: cn('w-full', className),
  } as const;

  if (isLoading && ordered.length === 0) {
    return (
      <div {...wrapperProps}>
        {loadingState ?? (
          <div role="status" aria-label="Loading" className="grid grid-cols-[auto_1fr] gap-x-4 sm:gap-x-6">
            <div className="flex flex-col gap-10">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-16 rounded-full" />
              ))}
            </div>
            <div className="flex flex-col gap-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full rounded-xl" />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (error && ordered.length === 0) {
    return (
      <div {...wrapperProps}>
        {errorState?.(error) ?? (
          <div role="alert" className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <TriangleAlert className="size-10 text-destructive" />
            <div>
              <p className="font-medium">Something went wrong</p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </div>
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div {...wrapperProps}>
        {emptyState ?? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No releases yet</EmptyTitle>
              <EmptyDescription>Milestones will appear here as they ship.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  return (
    <div {...wrapperProps}>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 sm:gap-x-6">
        {/* Decorative marker rail — the accessible source of truth is the <ol> below. */}
        <div aria-hidden="true" data-slot="timeline-rail" className="relative flex flex-col items-end">
          {ordered.map((m) => {
            const active = m.id === effectiveActiveId;
            const date = toDate(m.date);
            return (
              <div
                key={m.id}
                data-slot="timeline-marker"
                data-active={active}
                style={active ? { position: 'sticky', top: `${stickyOffset}px` } : undefined}
                className={cn('flex flex-1 flex-col items-end gap-1 pb-10 text-right', active && !reducedMotion && 'transition-transform')}
              >
                {m.version ? (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {m.version}
                  </span>
                ) : null}
                {date ? <span className="text-xs text-muted-foreground">{format(date, 'MMM yyyy')}</span> : null}
                <span
                  data-slot="timeline-marker-dot"
                  data-active={active}
                  className={cn('size-3 rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/50', active && !reducedMotion && 'animate-pulse')}
                />
              </div>
            );
          })}
        </div>

        {/* Accessible ordered list of milestones. */}
        <ol data-slot="timeline-entries" aria-label={ariaLabel} className="flex flex-col gap-6 border-l pl-4 sm:pl-6">
          {ordered.map((m) => {
            const titleId = `timeline-${m.id}-title`;
            const date = toDate(m.date);
            return (
              <li key={m.id}>
                <article
                  ref={register(m.id)}
                  data-slot="timeline-entry"
                  data-id={m.id}
                  data-density={density}
                  aria-labelledby={titleId}
                  className={cn('rounded-xl border bg-card text-card-foreground', density === 'compact' ? 'p-3' : 'p-4')}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    {m.version ? <span className="font-mono text-xs text-muted-foreground">{m.version}</span> : null}
                    <span id={titleId} className="text-sm font-semibold">
                      {m.title}
                    </span>
                  </div>
                  {date ? (
                    <time className="mt-0.5 block text-xs text-muted-foreground" dateTime={date.toISOString()}>
                      {format(date, 'PP')}
                    </time>
                  ) : null}
                  {m.intro ? <p className="mt-2 text-sm text-muted-foreground">{m.intro}</p> : null}

                  {m.media ? (
                    <div className="mt-3">
                      <RenderedContent contentKey={`${m.id}:media`} timestamp={m.date} content={m.media} density={density} renderers={renderers} />
                    </div>
                  ) : null}

                  {m.sections?.length ? (
                    <div className="mt-3 flex flex-col gap-2">
                      {m.sections.map((s) => {
                        const sid = `${m.id}:${s.id}`;
                        const open = sections.isExpanded(sid);
                        const contentId = `timeline-${m.id}-${s.id}-content`;
                        return (
                          <div key={s.id} data-slot="timeline-section">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={open ? contentId : undefined}
                              onClick={() => sections.toggle(sid)}
                              className="flex w-full items-center gap-2 rounded-sm py-1 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <ChevronDown
                                aria-hidden="true"
                                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
                              />
                              {s.label}
                            </button>
                            {open ? (
                              <div id={contentId} data-slot="timeline-section-content" className="pl-6">
                                <RenderedContent
                                  contentKey={contentId}
                                  timestamp={m.date}
                                  content={s.content}
                                  density={density}
                                  renderers={renderers}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
