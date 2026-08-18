'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconBroadcast } from '@tabler/icons-react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useLiveSession, useLiveSessions } from '../api';
import type { LiveSessionStats } from '../api';

function StatItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-xs tabular-nums">{children}</dd>
    </div>
  );
}

/** Fresh per-session snapshot via GET live/sessions/:id (frame 38's optional drill-in). */
function LiveSessionDetail({ consultationId }: { consultationId: string }) {
  const statsQuery = useLiveSession(consultationId);
  const stats = statsQuery.data;

  if (statsQuery.isLoading) return <Skeleton className="h-16 w-full" />;
  if (statsQuery.error) return <ErrorState title="Session stats unavailable" error={statsQuery.error} onRetry={() => void statsQuery.refetch()} />;
  if (!stats) return null;

  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-2 border-t pt-2">
      <StatItem label="Flushes">{formatNumber(stats.flushCount)}</StatItem>
      <StatItem label="Generation">{formatNumber(stats.generation)}</StatItem>
      <StatItem label="Stale drops">{formatNumber(stats.staleDropCount)}</StatItem>
      <StatItem label="Text latency">{formatNumber(stats.textLatencyMs)} ms</StatItem>
      <StatItem label="NLP latency">{formatNumber(stats.nlpLatencyMs)} ms</StatItem>
      <StatItem label="Entities">{formatNumber(stats.entityCount)}</StatItem>
      <StatItem label="Sections">{formatNumber(stats.sectionCount)}</StatItem>
      <StatItem label="Summary size">{formatNumber(stats.summaryChars)} chars</StatItem>
      <StatItem label="Last flush">{formatRelativeTime(stats.lastUpdatedAt)}</StatItem>
    </dl>
  );
}

function SessionRow({ session, expanded, onToggle }: { session: LiveSessionStats; expanded: boolean; onToggle: () => void }) {
  const degraded = session.textFailed || session.nlpFailed;
  return (
    <li className="rounded-md border">
      <button
        type="button"
        className="focus-visible:ring-ring flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="block max-w-40 truncate font-mono text-xs" title={session.consultationId}>
            {session.consultationId}
          </span>
          <span className="text-muted-foreground text-xs">
            started {formatRelativeTime(session.startedAt)} {'\u00b7'} {formatNumber(session.flushCount)} flushes
          </span>
        </span>
        {degraded ? (
          <StatusBadge
            label={session.textFailed && session.nlpFailed ? 'Text + NLP failing' : session.textFailed ? 'Text failing' : 'NLP failing'}
            colorRole="warning"
            icon={<IconAlertTriangle aria-hidden />}
          />
        ) : (
          <StatusBadge label="Streaming" colorRole="success" icon={<IconBroadcast aria-hidden />} />
        )}
      </button>
      {expanded ? (
        <div className="px-2.5 pb-2">
          <LiveSessionDetail consultationId={session.consultationId} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Frame 38 LIVE SESSIONS card — PHI-safe stats only (sizes/latencies/counts).
 * The DTO carries no max-session or stage field; the card shows the active
 * count and per-session flush/latency health instead.
 */
export function LiveSessionsCard() {
  const sessionsQuery = useLiveSessions();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sessions = sessionsQuery.data?.items ?? [];

  return (
    <section className="flex flex-col gap-2 border-t pt-3">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Live sessions</h3>
      {sessionsQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : sessionsQuery.error ? (
        <ErrorState title="Live sessions unavailable" error={sessionsQuery.error} onRetry={() => void sessionsQuery.refetch()} />
      ) : (
        <>
          <p className="text-sm tabular-nums">
            {formatNumber(sessionsQuery.data?.total ?? 0)} active
            <span aria-hidden className="text-muted-foreground font-mono text-xs">
              {' '}
              {'\u00b7'} GET live/sessions
            </span>
          </p>
          {sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No live-documentation sessions are streaming right now.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Active live-documentation sessions">
              {sessions.map((session) => (
                <SessionRow
                  key={session.consultationId}
                  session={session}
                  expanded={expandedId === session.consultationId}
                  onToggle={() => setExpandedId((current) => (current === session.consultationId ? null : session.consultationId))}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
