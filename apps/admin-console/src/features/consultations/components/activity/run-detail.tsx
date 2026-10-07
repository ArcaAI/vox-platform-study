'use client';

import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber } from '@/shared/format';
import {
  guardrailActionTakenMeta,
  guardrailCategoryLabel,
  guardrailCheckLabel,
  guardrailDirectionShortLabel,
  guardrailVerdictLabel,
} from '@/shared/guardrail/labels';
import { useItemRuns } from '../../api';
import { useRunGuardrailEvaluations } from '../../api/guardrail';
import { formatDuration, formatRunCost, formatTokenPair } from './activity-format';

/** The AI runs that produced the viewed version, one row per workflow step. */
export function RunDetail({ consultationId, itemId, version }: { consultationId: string; itemId: string; version: number }) {
  const runs = useItemRuns(consultationId, itemId, version);
  if (runs.isPending) return <Skeleton className="h-16 w-full" />;
  if (runs.isError || runs.data.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Run</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[26rem] text-xs">
          <caption className="sr-only">AI runs that produced version {version}</caption>
          <thead className="bg-muted/50 text-muted-foreground text-left">
            <tr>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Step
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Agent
              </th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">
                Time
              </th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">
                Tokens in/out
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Context
              </th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((run) => (
              <tr key={run.id} className="border-t">
                <td className="px-2.5 py-1.5">{run.nodeLabel ?? run.nodeId}</td>
                <td className="px-2.5 py-1.5 font-mono">{run.agentSlug}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{formatDuration(run.durationMs)}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{formatTokenPair(run.tokensIn, run.tokensOut)}</td>
                <td className="px-2.5 py-1.5 tabular-nums">{`${formatNumber(run.contextUsed)} / ${formatNumber(run.contextWindow)}`}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{formatRunCost(run.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RunGuardrailChecks consultationId={consultationId} runIds={runs.data.map((run) => run.runId)} />
    </div>
  );
}

/**
 * TASK-1050 W3b — the guardrail checks of the run(s) that produced this version: every screen of those
 * runs, direction by direction, with each check's verdict and what was done. Verdicts only, no content.
 * Asked by run (`runId` / `runKey` filters) and matched again client-side, in case a gateway ignores them.
 */
export function RunGuardrailChecks({ consultationId, runIds }: { consultationId: string; runIds: readonly string[] }) {
  const { rows, isPending, isError } = useRunGuardrailEvaluations(consultationId, runIds);
  if (runIds.length === 0 || isError) return null;
  if (isPending) return <Skeleton className="h-10 w-full" />;
  if (rows.length === 0) return null;
  return (
    <section aria-label="Guardrail checks of this run" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Guardrail checks</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[26rem] text-xs">
          <caption className="sr-only">Guardrail checks of the runs that produced this version</caption>
          <thead className="bg-muted/50 text-muted-foreground text-left">
            <tr>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Direction
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Check
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Verdict
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Action taken
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Category
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row) =>
              row.checks.map((check) => {
                const taken = guardrailActionTakenMeta(check.actionTaken);
                return (
                  <tr key={`${row.evaluationId}-${check.checkId}`} className="border-t">
                    <td className="px-2.5 py-1.5">{guardrailDirectionShortLabel(row.direction)}</td>
                    <td className="px-2.5 py-1.5">{guardrailCheckLabel(check.checkId)}</td>
                    <td className="px-2.5 py-1.5">{guardrailVerdictLabel(check.verdict)}</td>
                    <td className="px-2.5 py-1.5">
                      <StatusBadge label={taken.label} colorRole={taken.role} />
                    </td>
                    <td className="text-muted-foreground px-2.5 py-1.5">{check.category ? guardrailCategoryLabel(check.category) : '—'}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
