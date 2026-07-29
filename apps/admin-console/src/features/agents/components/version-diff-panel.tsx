'use client';

import { useState } from 'react';
import { IconCheck } from '@tabler/icons-react';
import { toast } from 'sonner';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useActivateVersion, useVersionDiff, useVersions } from '../api/hooks';
import type { PromptDiffChange, PromptTemplate, PromptVersion } from '../api/types';

function VersionRow({ version, isActive }: { version: PromptVersion; isActive: boolean }) {
  return (
    <li className="flex min-h-8 items-center gap-3 text-sm">
      <span className="w-8 shrink-0 font-mono text-xs">v{version.versionNumber}</span>
      <span className="w-16 shrink-0">
        {isActive ? (
          <StatusDot colorRole="success" size="sm" label={<span className="text-xs">Active</span>} />
        ) : (
          <span aria-hidden className="text-muted-foreground">
            {'\u2014'}
          </span>
        )}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDateTime(version.createdAt, 'date')}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-right font-mono text-xs">{version.changedBy ?? '\u2014'}</span>
    </li>
  );
}

/**
 * One side of the side-by-side view, rebuilt from the combined line-diff
 * segments: the "from" column drops `added` segments, the "to" column drops
 * `removed` ones, and each column tints the segments it uniquely owns.
 */
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
 * Frame 32 panel (a): version timeline for the selected template, the
 * side-by-side diff (GET :id/versions/:from/diff/:to) and the confirm-gated
 * version rollback (POST :id/versions/:v/activate). Parents key this by
 * template id so picker state resets on selection change.
 */
export function VersionsPanel({ template }: { template: PromptTemplate }) {
  const versionsQuery = useVersions(template.id);
  const activate = useActivateVersion();
  const [fromPick, setFromPick] = useState('');
  const [toPick, setToPick] = useState('');
  const [confirmingActivate, setConfirmingActivate] = useState(false);

  const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
  // Defaults: compare the previous version against the latest.
  const to = toPick ? Number(toPick) : (versions[0]?.versionNumber ?? null);
  const from = fromPick ? Number(fromPick) : (versions[1]?.versionNumber ?? null);

  const diffQuery = useVersionDiff(template.id, from, to);
  const diff = diffQuery.data;

  function handleActivateConfirmed() {
    if (from === null) return;
    activate.mutate(
      { id: template.id, versionNumber: from },
      {
        onSuccess: (updated) => {
          toast.success(`Version ${from} re-applied as v${updated.currentVersionNumber}`);
          setConfirmingActivate(false);
        },
        onError: (error) => {
          toast.error(error instanceof GatewayError ? error.message : 'Could not activate the version.');
          setConfirmingActivate(false);
        },
      },
    );
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-semibold">
          Versions
          <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
            :id/versions + diff
          </span>
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
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
                <VersionRow key={version.id} version={version} isActive={version.versionNumber === template.currentVersionNumber} />
              ))}
            </ol>
            {versions.length < 2 ? (
              <p className="text-muted-foreground text-xs">Only one version yet — saving a content edit creates v2.</p>
            ) : (
              <>
                <Separator />
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={from === null ? '' : String(from)} onValueChange={setFromPick}>
                    <SelectTrigger aria-label="Diff from version" size="sm" className="min-w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((version) => (
                        <SelectItem key={version.id} value={String(version.versionNumber)}>
                          v{version.versionNumber}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span aria-hidden className="text-muted-foreground text-xs">
                    {'\u21c4'}
                  </span>
                  <Select value={to === null ? '' : String(to)} onValueChange={setToPick}>
                    <SelectTrigger aria-label="Diff to version" size="sm" className="min-w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((version) => (
                        <SelectItem key={version.id} value={String(version.versionNumber)}>
                          v{version.versionNumber}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={from === null || from === template.currentVersionNumber || activate.isPending}
                  onClick={() => setConfirmingActivate(true)}
                >
                  <IconCheck aria-hidden />
                  Activate v{from ?? '?'}
                </Button>
              </>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmingActivate}
        onOpenChange={setConfirmingActivate}
        title={`Activate version ${from}?`}
        description={`Re-applies the v${from} content of "${template.name}" as a new active version (the history keeps every version). Currently active: v${template.currentVersionNumber}.`}
        confirmLabel={`Activate v${from}`}
        onConfirm={handleActivateConfirmed}
        isPending={activate.isPending}
      />
    </Card>
  );
}
