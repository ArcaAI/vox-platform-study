'use client';

/**
 * `LastRunTab` — TASK-1036 OD-17 / §10.1 "Last run in the inspector": this step's resolved
 * inputs, outputs, duration and tokens from the latest Test run.
 *
 * THE FEED CONTRACT (lane C3, the Test tab, supplies it):
 *
 *   type NodeLastRun = {
 *     inputs: Record<string, unknown>;   // resolved bindings, by input name
 *     outputs: Record<string, unknown>;  // declared output fields, by name
 *     durationMs: number | null;
 *     status: 'SUCCEEDED' | 'DEGRADED' | 'FAILED' | 'SKIPPED' | 'RUNNING' | string;
 *     tokens?: { in?: number; out?: number };   // optional
 *     error?: string;                           // optional, shown on FAILED
 *   } | null;
 *
 * `null` (no run yet) renders the empty state. Values are rendered compactly, never dumped.
 */
import { Badge, Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@arcaai/ui';
import { IconPlayerPlay } from '@tabler/icons-react';
import { formatSample } from '../../lib/picker-model';

export interface NodeLastRunData {
  inputs: Readonly<Record<string, unknown>>;
  outputs: Readonly<Record<string, unknown>>;
  durationMs: number | null;
  status: string;
  tokens?: { in?: number; out?: number };
  error?: string;
}

export type NodeLastRun = NodeLastRunData | null;

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = { FAILED: 'destructive', RUNNING: 'secondary' };

function Values({ title, values }: { title: string; values: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(values);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">None.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="font-mono">{name}</dt>
              <dd className="text-muted-foreground min-w-0 truncate" title={typeof value === 'string' ? value : undefined}>
                {formatSample(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function LastRunTab({ lastRun }: { lastRun: NodeLastRun | undefined }) {
  if (!lastRun) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconPlayerPlay aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No test run yet</EmptyTitle>
        <EmptyDescription>Run this workflow from the Test tab to see what this step received and produced.</EmptyDescription>
      </Empty>
    );
  }
  const tokens = lastRun.tokens;
  return (
    <div className="flex flex-col gap-3" data-slot="last-run">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={STATUS_VARIANT[lastRun.status] ?? 'outline'}>{lastRun.status}</Badge>
        <span className="tabular-nums">{duration(lastRun.durationMs)}</span>
        {tokens && (tokens.in !== undefined || tokens.out !== undefined) ? (
          <span className="text-muted-foreground tabular-nums">
            {(tokens.in ?? 0).toLocaleString('en-US')} in · {(tokens.out ?? 0).toLocaleString('en-US')} out
          </span>
        ) : null}
      </div>
      {lastRun.error ? <p className="text-destructive text-sm">{lastRun.error}</p> : null}
      <Values title="Inputs" values={lastRun.inputs} />
      <Values title="Outputs" values={lastRun.outputs} />
    </div>
  );
}
