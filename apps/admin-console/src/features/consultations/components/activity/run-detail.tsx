'use client';

import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatNumber } from '@/shared/format';
import { useItemRuns } from '../../api';
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
              <th scope="col" className="px-2.5 py-1.5 font-semibold">Step</th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">Agent</th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">Time</th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">Tokens in/out</th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">Context</th>
              <th scope="col" className="px-2.5 py-1.5 text-right font-semibold">Cost</th>
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
    </div>
  );
}
