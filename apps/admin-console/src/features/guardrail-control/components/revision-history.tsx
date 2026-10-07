'use client';

import { IconHistory, IconRestore } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useGuardrailPolicyRevisions, useRestoreGuardrailPolicyRevision } from '../api/hooks';
import { ControlErrorState } from './control-states';
import { displayValue, writeErrorMessage } from './guardrail-control-logic';

/** A key's revision history (newest first) with Restore. Restore re-validates against today's catalogue. */
export function RevisionHistory({ policyKey }: { policyKey: string }) {
  const query = useGuardrailPolicyRevisions(policyKey, true);
  const restore = useRestoreGuardrailPolicyRevision();

  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  const revisions = query.data.revisions;
  if (revisions.length === 0) {
    return (
      <EmptyState icon={IconHistory} title="No revisions yet" description="Every save, reset and restore of this key appends a revision here." />
    );
  }
  return (
    <ol className="flex flex-col gap-2" aria-label={`Revisions of ${policyKey} (${revisions.length})`}>
      {revisions.map((revision, index) => (
        <li key={revision.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={index === 0 ? 'default' : 'outline'}>{index === 0 ? 'current' : revision.reason}</Badge>
              {index === 0 ? <Badge variant="secondary">{revision.reason}</Badge> : null}
              <time dateTime={revision.at} title={formatDateTime(revision.at)}>
                {formatRelativeTime(revision.at)}
              </time>
              <span className="text-muted-foreground font-mono text-xs">by {revision.actorId.slice(0, 8)}</span>
              <span className="text-muted-foreground font-mono text-xs">#{revision.valueHash.slice(0, 10)}</span>
            </span>
            {index > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate(
                    { key: policyKey, revisionId: revision.id },
                    { onSuccess: () => toast.success(`${policyKey} restored`), onError: (error) => toast.error(writeErrorMessage(error)) },
                  )
                }
              >
                <IconRestore aria-hidden />
                Restore
              </Button>
            ) : null}
          </div>
          <details>
            <summary className="text-muted-foreground cursor-pointer text-xs">Show value</summary>
            <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
              {displayValue(revision.value)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
