'use client';

/**
 * "Which workflow governed this consultation, and did it work?" — one row in the
 * consultation detail's `<dl>`, from the `governingRun` already on the
 * response. No extra request.
 *
 * Until now these screens never read `GET consultations/:id/workflow` at all, so
 * a governed run that FAILED was invisible here: the consultation looked
 * ordinary while its note had been written without the workflow the tenant
 * configured. That state is the reason this row exists, which is why the failure
 * carries a plain-language sentence AND the gateway's raw reason — the sentence
 * is for the admin reading the screen, the raw reason is what they paste to
 * their integrator.
 *
 * Degradation is a per-run FLAG, never a status: `COMPLETED` + `degraded` reads
 * "Completed with warnings", and `DEGRADED` is not a value this row can render.
 */

import Link from 'next/link';
import { IconArrowRight } from '@tabler/icons-react';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { GoverningRun } from '../api/types';

const RUN_STATUS_META: Record<GoverningRun['status'], { label: string; role: StatusColorRole }> = {
  RUNNING: { label: 'Running', role: 'primary' },
  COMPLETED: { label: 'Completed', role: 'success' },
  FAILED: { label: 'Failed', role: 'destructive' },
  CANCELED: { label: 'Canceled', role: 'neutral' },
  TIMED_OUT: { label: 'Timed out', role: 'warning' },
};

function chipFor(run: GoverningRun): { label: string; role: StatusColorRole } {
  if (run.status === 'COMPLETED' && run.degraded) return { label: 'Completed with warnings', role: 'warning' };
  return RUN_STATUS_META[run.status] ?? { label: run.status, role: 'neutral' as StatusColorRole };
}

export function ConsultationWorkflowMeta({ run }: { run: GoverningRun | null | undefined }) {
  return (
    <div className="col-span-2 flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">Workflow</dt>
      <dd className="text-sm break-all">
        {!run ? (
          <span className="text-muted-foreground">Not governed by a workflow</span>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{run.workflowDefinitionSlug}</span>
              {(() => {
                const chip = chipFor(run);
                return <StatusBadge label={chip.label} colorRole={chip.role} icon={<StatusDot colorRole={chip.role} size="sm" />} />;
              })()}
              <Link
                href={`/workflow-runs/${encodeURIComponent(run.workflowRunId)}`}
                className="inline-flex items-center gap-1 underline underline-offset-4"
              >
                View run
                <IconArrowRight aria-hidden className="size-3" />
              </Link>
            </span>
            {run.status === 'FAILED' ? (
              <>
                <span className="text-muted-foreground text-xs">
                  This consultation ran without its workflow. Reason: the context didn&apos;t match what the workflow accepts.
                </span>
                {run.failureReason ? <span className="text-muted-foreground font-mono text-xs">{run.failureReason}</span> : null}
              </>
            ) : null}
          </span>
        )}
      </dd>
    </div>
  );
}
