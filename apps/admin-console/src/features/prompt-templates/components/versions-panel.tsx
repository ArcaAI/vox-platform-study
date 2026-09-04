'use client';

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useVersionDiff, useVersions } from '../api';
import type { PromptDiffChange, PromptTemplate } from '../api';

/** One side of the side-by-side diff, tinting only the segments it uniquely owns. */
function DiffColumn({ heading, segments, highlight }: { heading: string; segments: PromptDiffChange[]; highlight: 'removed' | 'added' }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground font-mono text-xs">{heading}</span>
      <pre className="bg-muted/40 max-h-56 overflow-y-auto rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap">
        {segments.map((segment, index) => (
          <span
            key={index}
            className={
              highlight === 'removed' && segment.removed ? 'bg-destructive/15' : highlight === 'added' && segment.added ? 'bg-success/15' : undefined
            }
          >
            {segment.value}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Version timeline for the selected template + the server-diff viewer
 * (GET :id/versions/:from/diff/:to). Read-only in Prompt Studio — rollback
 * lives on the tenant Agents screen; here it documents provenance ahead of
 * the governance approval.
 */
export function VersionsPanel({ template }: { template: PromptTemplate }) {
  const versionsQuery = useVersions(template.id);
  const [fromPick, setFromPick] = useState('');
  const [toPick, setToPick] = useState('');

  const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
  const to = toPick ? Number(toPick) : (versions[0]?.versionNumber ?? null);
  const from = fromPick ? Number(fromPick) : (versions[1]?.versionNumber ?? null);

  const diffQuery = useVersionDiff(template.id, from, to);
  const diff = diffQuery.data;

  return (
    <Card className="gap-4 p-4">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-medium">
        Version history
        <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
          :id/versions + diff
        </span>
      </h3>
      {versionsQuery.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      ) : versionsQuery.error ? (
        <ErrorState error={versionsQuery.error} onRetry={() => void versionsQuery.refetch()} />
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No versions recorded yet.</p>
      ) : (
        <>
          <ol aria-label={`Versions of ${template.name}`} className="flex flex-col gap-1">
            {versions.map((version) => (
              <li key={version.id} className="flex min-h-8 items-center gap-3 text-sm">
                <span className="w-8 shrink-0 font-mono text-xs">v{version.versionNumber}</span>
                {/*
                 * Two DIFFERENT facts, deliberately shown side by side:
                 * "draft" is the current editable content row, "serving" is
                 * the snapshot pinned at approval \u2014 which is what clinical
                 * resolution actually runs. They diverge whenever a template
                 * is edited after approval.
                 */}
                <span className="flex w-32 shrink-0 gap-1">
                  {version.versionNumber === template.approvedVersionNumber ? (
                    <Badge variant="default" className="text-xs">
                      serving
                    </Badge>
                  ) : null}
                  {version.versionNumber === template.currentVersionNumber ? (
                    <Badge variant="secondary" className="text-xs">
                      draft
                    </Badge>
                  ) : null}
                  {version.versionNumber !== template.approvedVersionNumber && version.versionNumber !== template.currentVersionNumber ? (
                    <span aria-hidden className="text-muted-foreground">
                      {'\u2014'}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDateTime(version.createdAt, 'date')}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">{version.changedBy ?? '\u2014'}</span>
              </li>
            ))}
          </ol>
          {versions.length < 2 ? (
            <p className="text-muted-foreground text-xs">Only one version yet — nothing to diff.</p>
          ) : (
            <>
              <Separator />
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  aria-label="Diff from version"
                  value={from === null ? '' : String(from)}
                  onChange={(event) => setFromPick(event.target.value)}
                  className="h-8 w-20 text-xs"
                >
                  {versions.map((version) => (
                    <NativeSelectOption key={version.id} value={String(version.versionNumber)}>
                      v{version.versionNumber}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <span aria-hidden className="text-muted-foreground text-xs">
                  {'\u21c4'}
                </span>
                <NativeSelect
                  aria-label="Diff to version"
                  value={to === null ? '' : String(to)}
                  onChange={(event) => setToPick(event.target.value)}
                  className="h-8 w-20 text-xs"
                >
                  {versions.map((version) => (
                    <NativeSelectOption key={version.id} value={String(version.versionNumber)}>
                      v{version.versionNumber}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {diff ? (
                  <span className="ml-auto flex items-center gap-1">
                    <Badge variant="outline" className="text-success tabular-nums">
                      +{diff.stats.additions}
                    </Badge>
                    <Badge variant="outline" className="text-destructive tabular-nums">
                      {'\u2212'}
                      {diff.stats.deletions}
                    </Badge>
                  </span>
                ) : null}
              </div>
              {from === to ? (
                <p className="text-muted-foreground text-xs">Pick two different versions to compare.</p>
              ) : diffQuery.isPending ? (
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : diffQuery.error ? (
                <ErrorState error={diffQuery.error} onRetry={() => void diffQuery.refetch()} />
              ) : diff ? (
                <div className="grid grid-cols-2 gap-2">
                  <DiffColumn heading={`v${diff.fromVersion}`} segments={diff.changes.filter((change) => !change.added)} highlight="removed" />
                  <DiffColumn heading={`v${diff.toVersion}`} segments={diff.changes.filter((change) => !change.removed)} highlight="added" />
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </Card>
  );
}
