'use client';

/**
 * The Test tab's Events (TASK-1036 §10.2): every event of the run in order — seq, +time, step,
 * type and a readable line — with category filters and their counts, and search. Clicking an
 * event opens its full JSON payload and TIME-TRAVELS the whole tab to that moment (the parent owns
 * the cursor and the "Back to live" banner).
 */
import { useId, useMemo, useState } from 'react';
import { Badge, Input, Skeleton, ToggleGroup, ToggleGroupItem } from '@arcaai/ui';
import { CopyButton } from '@/shared/copy-button';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABEL, categoriesOf, countByCategory, describeEvent, isWarningEvent, matchesEventQuery, relativeTime, type EventCategory } from './lib/event-display';
import { maskPayload } from './lib/phi';
import { Panel } from './panel';

/** Rows rendered at once; a long stream of deltas must not grow the DOM without bound. */
const MAX_ROWS = 500;

export interface EventsPanelProps {
  events: readonly RunEvent[];
  originTs: string | undefined;
  labelOf: (nodeId: string) => string;
  hidePhi: boolean;
  /** Index (0-based) of the event the view is pinned to, or `null` while live. */
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  /** A run has started and nothing has streamed yet. */
  waiting: boolean;
}

export function EventsPanel({ events, originTs, labelOf, hidePhi, selectedIndex, onSelect, waiting }: EventsPanelProps) {
  const searchId = useId();
  const [filters, setFilters] = useState<EventCategory[]>([]);
  const [query, setQuery] = useState('');
  const counts = useMemo(() => countByCategory(events), [events]);

  const rows = useMemo(() => {
    const indexed = events.map((event, index) => ({ event, index }));
    return indexed.filter(
      ({ event }) =>
        (filters.length === 0 || categoriesOf(event).some((category) => filters.includes(category))) && matchesEventQuery(event, query, labelOf, { hidePhi }),
    );
  }, [events, filters, query, labelOf, hidePhi]);
  const visible = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;

  return (
    <Panel
      title={
        <>
          Events <Badge variant="secondary">{events.length.toLocaleString('en-US')}</Badge>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="multiple" size="sm" variant="outline" spacing={1} aria-label="Filter events" value={filters} onValueChange={(next) => setFilters(next as EventCategory[])} className="flex-wrap">
          {EVENT_CATEGORIES.map((category) => (
            <ToggleGroupItem key={category} value={category} className="rounded-full px-2.5 text-xs">
              {`${EVENT_CATEGORY_LABEL[category]} · ${counts[category]}`}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <label htmlFor={searchId} className="sr-only">
          Search events
        </label>
        <Input id={searchId} type="search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 w-full sm:ml-auto sm:w-48" />
      </div>

      {events.length === 0 && waiting ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">Waiting for the run’s first event…</p>
          {[0, 1, 2].map((row) => (
            <div key={row} aria-hidden="true" className="grid grid-cols-[2.5rem_4rem_minmax(0,1fr)] gap-2 px-2">
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground text-sm">Press Run test to start. Every event of the run appears here as it happens.</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No event matches these filters.</p>
      ) : (
        <>
          {rows.length > visible.length ? (
            <p className="text-muted-foreground text-xs">
              Showing the latest {visible.length.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')} matching events.
            </p>
          ) : null}
          <ol className="flex flex-col">
            {visible.map(({ event, index }) => {
              const selected = selectedIndex === index;
              const stepLabel = event.nodeId ? labelOf(event.nodeId) : 'Run';
              const time = relativeTime(event.ts, originTs);
              const text = describeEvent(event, labelOf, { hidePhi });
              const warning = isWarningEvent(event);
              return (
                <li key={`${event.seq}-${index}`} className="border-t first:border-t-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`#${event.seq} ${time} ${stepLabel} ${event.type}: ${text}`}
                    onClick={() => onSelect(selected ? null : index)}
                    className={`hover:bg-muted/60 focus-visible:ring-ring grid w-full cursor-pointer grid-cols-[2.5rem_4rem_minmax(0,1fr)] items-baseline gap-2 px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none sm:grid-cols-[2.5rem_4rem_8rem_10rem_minmax(0,1fr)] ${selected ? 'bg-accent' : ''}`}
                  >
                    <span className="text-muted-foreground font-mono tabular-nums">#{event.seq}</span>
                    <span className="text-muted-foreground font-mono tabular-nums">{time}</span>
                    <span className="hidden truncate sm:block">{stepLabel}</span>
                    <span className="hidden truncate font-mono sm:block">{event.type}</span>
                    <span className={`min-w-0 break-words ${warning ? 'text-warning-strong' : ''}`}>{text}</span>
                  </button>
                  {selected ? (
                    <div className="flex flex-col gap-1 px-2 pb-2">
                      <div className="flex items-center gap-2">
                        <p className="text-muted-foreground text-xs">The flow, the step and the context above now show the state at this event.</p>
                        <span className="ml-auto">
                          <CopyButton value={JSON.stringify(hidePhi ? maskPayload(event) : event, null, 2)} label="Copy JSON" />
                        </span>
                      </div>
                      <pre className="bg-muted rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">{JSON.stringify(hidePhi ? maskPayload(event) : event, null, 2)}</pre>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Panel>
  );
}
