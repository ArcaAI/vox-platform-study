'use client';

import { IconTimeline } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { cn } from '@arcaai/ui';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSessions } from '../api';
import type { TrajectorySessionKind } from '../api';

const KINDS: { value: '' | TrajectorySessionKind; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'LIVE_DOC', label: 'Live doc' },
  { value: 'HARNESS_DOC', label: 'Harness doc' },
  { value: 'SUMMARY_JOB', label: 'Summary job' },
  { value: 'EVAL_RUN', label: 'Eval run' },
];

/** Session key combining sessionId + runId (runId "" for non-Temporal). */
export function sessionKey(sessionId: string, runId: string): string {
  return `${sessionId}#${runId}`;
}

/** Left rail: distinct trajectory sessions, filterable by kind. */
export function SessionList({
  kind,
  onKindChange,
  selectedKey,
  onSelect,
}: {
  kind: '' | TrajectorySessionKind;
  onKindChange: (kind: '' | TrajectorySessionKind) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const query = useSessions({ ...(kind ? { kind } : {}), limit: 50 });

  return (
    <Card className="flex min-h-0 flex-col gap-3 p-3 lg:h-full">
      <NativeSelect
        aria-label="Filter by session kind"
        value={kind}
        onChange={(event) => onKindChange(event.target.value as '' | TrajectorySessionKind)}
        className="h-8 text-xs"
      >
        {KINDS.map((option) => (
          <NativeSelectOption key={option.value || 'all'} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.items.length === 0 ? (
          <EmptyState icon={IconTimeline} title="No sessions" description="No agentic sessions recorded for this tenant and filter." />
        ) : (
          <ul aria-label="Agentic sessions" className="flex flex-col gap-1">
            {query.data.items.map((session) => {
              const key = sessionKey(session.sessionId, session.runId);
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onSelect(key)}
                    aria-current={key === selectedKey}
                    className={cn(
                      'hover:bg-accent flex w-full flex-col gap-1 rounded-md border p-2 text-left transition-colors',
                      key === selectedKey ? 'border-primary bg-accent' : 'border-transparent',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {session.sessionKind}
                      </Badge>
                      <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">{session.stepCount} steps</span>
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs">{session.sessionId}</span>
                    <span className="text-muted-foreground text-[11px]">last {formatRelativeTime(session.lastStepAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
