'use client';

import { useMemo } from 'react';
import { IconX } from '@tabler/icons-react';
import type { ActivityItemEntry, ItemVersionSummary } from '@arcaai/types';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { diffLines } from '@/shared/versioning/line-diff';
import { useItemDiff, useItemVersion, useItemVersions } from '../../api';
import { kindLabel } from './activity-format';
import { parseRecap } from './recap-model';
import { RecapPanel } from './recap-panel';
import { RunDetail } from './run-detail';

function contentOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = (value as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : '';
}

function VersionDiff({ consultationId, itemId, version, against }: { consultationId: string; itemId: string; version: number; against: number }) {
  const diff = useItemDiff(consultationId, itemId, version, against);
  if (diff.isPending) return <Skeleton className="h-20 w-full" />;
  if (diff.isError) return <ErrorState title={'Couldn’t load the changes'} error={diff.error} onRetry={() => void diff.refetch()} />;
  const result = diffLines(contentOf(diff.data.from), contentOf(diff.data.to));
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Changes from v{against}</h3>
      {result.identical ? (
        <p className="text-muted-foreground text-sm">No text changes.</p>
      ) : (
        <div className="bg-muted/40 flex flex-col rounded-md border p-2 font-mono text-xs">
          {result.lines.map((line, index) => {
            if (line.kind === 'added') {
              return (
                <ins key={index} className="bg-success/15 text-foreground block whitespace-pre-wrap no-underline">
                  <span aria-hidden>+ </span>
                  {line.text}
                </ins>
              );
            }
            if (line.kind === 'removed') {
              return (
                <del key={index} className="bg-destructive/15 text-foreground block whitespace-pre-wrap">
                  <span aria-hidden>{'−'} </span>
                  {line.text}
                </del>
              );
            }
            return (
              <span key={index} className="text-muted-foreground block whitespace-pre-wrap">
                <span aria-hidden>{' '} </span>
                {line.text}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VersionBody({
  consultationId,
  itemId,
  version,
  previous,
  onCitation,
}: {
  consultationId: string;
  itemId: string;
  version: number;
  previous: number | null;
  onCitation: (itemId: string, versionNumber: number) => void;
}) {
  const detail = useItemVersion(consultationId, itemId, version);
  if (detail.isPending) return <Skeleton className="h-24 w-full" />;
  if (detail.isError) return <ErrorState title={'Couldn’t load this version'} error={detail.error} onRetry={() => void detail.refetch()} />;
  const recap = parseRecap(detail.data.content);
  if (recap) return <RecapPanel sections={recap} onCitation={onCitation} />;
  if (previous !== null) return <VersionDiff consultationId={consultationId} itemId={itemId} version={version} against={previous} />;
  return <div className="bg-muted/40 rounded-md border p-2.5 text-sm whitespace-pre-wrap">{detail.data.content ?? 'No text content'}</div>;
}

function VersionMeta({ version }: { version: ItemVersionSummary }) {
  return (
    <span className="text-muted-foreground text-xs">
      {version.changedBy ?? 'system'} {'·'} {version.changeSource} {'·'} {formatDateTime(version.createdAt)}
    </span>
  );
}

/**
 * Non-modal side panel: every version of one item, the viewed version's text (or its changes from
 * the version before, as a line diff), and the AI runs behind it. Reading a version is an audited
 * decrypt, so only the viewed version is fetched.
 */
export function VersionHistoryPanel({
  consultationId,
  itemId,
  entry,
  version,
  onVersionChange,
  onClose,
  onSelectItem,
}: {
  consultationId: string;
  itemId: string;
  entry?: ActivityItemEntry;
  version: number | null;
  onVersionChange: (version: number) => void;
  onClose: () => void;
  onSelectItem: (itemId: string, versionNumber?: number) => void;
}) {
  const versions = useItemVersions(consultationId, itemId);
  const ordered = useMemo(() => [...(versions.data ?? [])].sort((a, b) => a.versionNumber - b.versionNumber), [versions.data]);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1].versionNumber : (entry?.latestVersion.number ?? null);
  const viewed = version ?? latest;
  const previous = viewed === null ? null : ([...ordered].reverse().find((candidate) => candidate.versionNumber < viewed)?.versionNumber ?? null);
  const viewedSummary = ordered.find((candidate) => candidate.versionNumber === viewed);

  return (
    <section
      aria-label="Version history"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="bg-card flex min-h-0 flex-col overflow-y-auto rounded-md border"
    >
      <div className="flex flex-col gap-1.5 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{entry ? kindLabel(entry.kind) : 'Item'}</h2>
          <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close version history" onClick={onClose}>
            <IconX aria-hidden />
          </Button>
        </div>
        <p className="text-muted-foreground font-mono text-xs break-all">{itemId}</p>
      </div>

      <div className="flex flex-col gap-4 px-4 py-3">
        {viewed === null ? (
          versions.isError ? (
            <ErrorState title={'Couldn’t load version history'} error={versions.error} onRetry={() => void versions.refetch()} />
          ) : (
            <Skeleton className="h-24 w-full" />
          )
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Viewing v{viewed}</h3>
              {viewed === latest ? <Badge variant="outline">Current</Badge> : null}
            </div>
            {viewedSummary ? <VersionMeta version={viewedSummary} /> : null}
            {viewedSummary?.changeReason ? <p className="text-sm">Reason: {'“'}{viewedSummary.changeReason}{'”'}</p> : null}
            <VersionBody consultationId={consultationId} itemId={itemId} version={viewed} previous={previous} onCitation={onSelectItem} />
            <RunDetail consultationId={consultationId} itemId={itemId} version={viewed} />
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            History <span className="text-muted-foreground font-normal">({ordered.length} versions, oldest first)</span>
          </h3>
          {versions.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <ol className="flex flex-col gap-1.5">
              {ordered.map((candidate) => (
                <li key={candidate.versionNumber}>
                  <button
                    type="button"
                    aria-pressed={candidate.versionNumber === viewed}
                    onClick={() => onVersionChange(candidate.versionNumber)}
                    className="hover:bg-accent aria-pressed:border-primary focus-visible:ring-ring flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="font-semibold">
                      v{candidate.versionNumber}
                      {candidate.versionNumber === latest ? ' (current)' : ''}
                    </span>
                    <VersionMeta version={candidate} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
