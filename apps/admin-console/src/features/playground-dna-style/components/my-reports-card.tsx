'use client';

import { useState } from 'react';
import { IconDna, IconStar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEraseMyReport, useMyReports, useMyVersions, useSetDefaultReport } from '../api';
import { erasureSummary } from './dna-erasure-card';

/** GET :reportId/versions — the DnaVersion history, newest first (frame 53). */
function VersionTimeline({ reportId }: { reportId: string }) {
  const versions = useMyVersions(reportId);

  if (versions.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (versions.isError) {
    return <ErrorState title={'Couldn\u2019t load the version timeline'} error={versions.error} onRetry={() => void versions.refetch()} />;
  }
  if (versions.data.length === 0) {
    return <p className="text-muted-foreground text-xs">No versions recorded yet.</p>;
  }

  const rows = [...versions.data].sort((a, b) => b.versionNumber - a.versionNumber);
  return (
    <ol aria-label="Version history" className="flex flex-col">
      {rows.map((version) => (
        <li key={version.id} className="flex items-baseline gap-2 border-b py-1.5 text-xs last:border-0">
          <span className="font-medium tabular-nums">v{version.versionNumber}</span>
          <time dateTime={version.createdAt} className="text-muted-foreground shrink-0">
            {formatDateTime(version.createdAt, 'date')}
          </time>
          <span className="text-muted-foreground min-w-0 flex-1 truncate" title={version.changeReason}>
            {version.changeReason || 'auto-generate'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Frame 53 — the caller's report history (GET /mine) with the set-default
 * action (PATCH :reportId/default) and a row selection that re-targets the
 * DnaVersion timeline below. The timeline follows the my-style report until
 * a row is picked.
 */
export function MyReportsCard({
  reports,
  myStyleReportId,
  gated,
  onGate,
}: {
  reports: ReturnType<typeof useMyReports>;
  myStyleReportId: string | null;
  gated: boolean;
  onGate: () => void;
}) {
  const setDefault = useSetDefaultReport();
  const erase = useEraseMyReport();
  const [selected, setSelected] = useState<string | null>(null);
  const [eraseTarget, setEraseTarget] = useState<string | null>(null);
  const selectedId = selected ?? myStyleReportId;

  /**
   * `PATCH :reportId/default` requires `If-Match`; the validator is the row
   * version this list read, so it is echoed rather than invented.
   */
  function handleSetDefault(reportId: string, version: number) {
    setDefault.mutate(
      { reportId, etag: `"${version}"` },
      {
        onSuccess: () => toast.success('Default report updated'),
        onError: (error) => {
          if (error instanceof GatewayError && error.status === 412) {
            toast.error('This report changed since it was loaded. Refresh the list and try again.');
            return;
          }
          toast.error(error instanceof GatewayError ? error.message : 'Could not set the default report.');
        },
      },
    );
  }

  /** Single-report erasure (DELETE :reportId) — same 403 gate as the rest. */
  function handleErase() {
    if (!eraseTarget) return;
    erase.mutate(eraseTarget, {
      onSuccess: (result) => {
        setEraseTarget(null);
        setSelected(null);
        toast.success(erasureSummary(result));
      },
      onError: (error) => {
        setEraseTarget(null);
        if (error instanceof GatewayError && error.status === 403) {
          onGate();
          return;
        }
        toast.error(error instanceof GatewayError ? error.message : 'Could not erase the report.');
      },
    });
  }

  let body;
  if (reports.isPending) {
    body = (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  } else if (reports.isError) {
    body = <ErrorState title={'Couldn\u2019t load your reports'} error={reports.error} onRetry={() => void reports.refetch()} />;
  } else if (reports.data.length === 0) {
    body = <EmptyState icon={IconDna} title="No reports yet" description="Generated reports appear here with their version history." />;
  } else {
    const rows = [...reports.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    body = (
      <ul aria-label="My reports" className="flex flex-col">
        {rows.map((report) => {
          const isSelected = report.id === selectedId;
          return (
            <li key={report.id} className="flex items-center gap-2 border-b py-1.5 last:border-0">
              <button
                type="button"
                aria-label={`Show versions of ${report.id}`}
                aria-pressed={isSelected}
                onClick={() => setSelected(report.id)}
                className={cn(
                  'focus-visible:ring-ring/50 hover:bg-accent flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2 rounded-md px-2 py-1 text-left text-xs focus-visible:ring-[3px] focus-visible:outline-none',
                  isSelected && 'bg-accent',
                )}
              >
                <span className="font-mono break-all">{report.id}</span>
                <span className="tabular-nums">v{report.currentVersionNumber}</span>
                {report.isLatest ? <Badge variant="secondary">Default</Badge> : null}
                <span className="text-muted-foreground ml-auto shrink-0">{formatDateTime(report.createdAt, 'date')}</span>
              </button>
              {!report.isLatest ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Set ${report.id} as default`}
                  onClick={() => handleSetDefault(report.id, report.version)}
                  disabled={setDefault.isPending}
                >
                  {setDefault.isPending && setDefault.variables?.reportId === report.id ? <Spinner /> : <IconStar aria-hidden />}
                  Set default
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Erase report ${report.id}`}
                onClick={() => setEraseTarget(report.id)}
                disabled={gated || erase.isPending}
                className="text-destructive hover:text-destructive"
              >
                {erase.isPending && erase.variables === report.id ? <Spinner /> : <IconTrash aria-hidden />}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">My reports {reports.data ? `(${reports.data.length})` : ''}</h2>
        <CardAction>
          <span aria-hidden className="text-muted-foreground font-mono text-xs">
            GET /mine
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {body}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold">Version history</h3>
          {selectedId ? (
            <VersionTimeline reportId={selectedId} />
          ) : (
            <p className="text-muted-foreground text-xs">Select a report to browse its versions.</p>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={eraseTarget !== null}
        onOpenChange={(open) => {
          if (!open && !erase.isPending) setEraseTarget(null);
        }}
        title="Erase this report"
        description={
          <>
            This permanently erases report <span className="text-foreground font-mono font-medium">{eraseTarget}</span> and all of its versions. Your
            other reports and your DNA on/off toggle are left untouched. It cannot be undone.
          </>
        }
        confirmLabel="Erase report"
        destructive
        isPending={erase.isPending}
        onConfirm={handleErase}
      />
    </Card>
  );
}
