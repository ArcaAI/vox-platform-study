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
 *
 * TASK-1036 review R-C:
 *  - #7 Hide PHI — the studio's switch (`hidePhi`, offered here as well as in the toolbar) masks
 *    every value whose field is PHI-classed (`phiFields`, from `lib/phi-mask.ts`); a NON_PHI value
 *    stays readable. A long value expands IN PLACE ("Show full value"), never only in a tooltip
 *    that a keyboard or touch user cannot reach.
 *  - #13 "Open full trace in Test" — the whole run (every event, the context, time travel) lives in
 *    the Test tab; this tab is the step's summary and links there.
 */
import { useId, useState } from 'react';
import { Badge, Button, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Label, Switch } from '@arcaai/ui';
import { IconExternalLink, IconPlayerPlay } from '@tabler/icons-react';
import { PHI_MASK, formatSample } from '../../lib/picker-model';

export interface NodeLastRunData {
  inputs: Readonly<Record<string, unknown>>;
  outputs: Readonly<Record<string, unknown>>;
  durationMs: number | null;
  status: string;
  tokens?: { in?: number; out?: number };
  error?: string;
}

export type NodeLastRun = NodeLastRunData | null;

export interface LastRunPhiFields {
  inputs: ReadonlySet<string>;
  outputs: ReadonlySet<string>;
}

export interface LastRunTabProps {
  lastRun: NodeLastRun | undefined;
  /** The studio's Hide PHI switch. */
  hidePhi?: boolean;
  /** Which input / output names carry PHI-classed values. */
  phiFields?: LastRunPhiFields;
  /** Renders the Hide PHI switch here when given. */
  onHidePhiChange?: (hide: boolean) => void;
  /** Renders "Open full trace in Test" when given. */
  onOpenTrace?: () => void;
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'destructive'> = { FAILED: 'destructive', RUNNING: 'secondary' };

/** The whole value, for the expanded view: a string verbatim, anything else as indented JSON. */
function fullText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Whether the compact rendering hides part of the value (and so earns a "Show full value"). */
function isAbbreviated(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 60;
  return typeof value === 'object';
}

function ValueRow({ name, value, masked }: { name: string; value: unknown; masked: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const expandable = !masked && isAbbreviated(value);
  return (
    <div className="contents">
      <dt className="font-mono">{name}</dt>
      <dd className="text-muted-foreground flex min-w-0 flex-col items-start gap-1">
        {masked ? (
          <span className="italic">{PHI_MASK}</span>
        ) : (
          <span className="max-w-full min-w-0 truncate">{formatSample(value)}</span>
        )}
        {expandable ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((previous) => !previous)}
          >
            {open ? 'Show less' : 'Show full value'}
            <span className="sr-only"> of {name}</span>
          </Button>
        ) : null}
        {expandable && open ? (
          <pre id={panelId} className="bg-muted text-foreground max-h-64 w-full overflow-auto rounded-sm p-2 font-mono text-xs whitespace-pre-wrap break-words">
            {fullText(value)}
          </pre>
        ) : null}
      </dd>
    </div>
  );
}

function Values({ title, values, phi, hidePhi }: { title: string; values: Readonly<Record<string, unknown>>; phi: ReadonlySet<string> | undefined; hidePhi: boolean }) {
  const entries = Object.entries(values);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">None.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([name, value]) => (
            <ValueRow key={name} name={name} value={value} masked={hidePhi && (phi?.has(name) ?? false)} />
          ))}
        </dl>
      )}
    </section>
  );
}

export function LastRunTab({ lastRun, hidePhi = false, phiFields, onHidePhiChange, onOpenTrace }: LastRunTabProps) {
  const switchId = useId();
  if (!lastRun) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconPlayerPlay aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No test run yet</EmptyTitle>
        <EmptyDescription>Run this workflow from the Test tab to see what this step received and produced.</EmptyDescription>
        {onOpenTrace ? (
          <Button type="button" variant="outline" size="sm" onClick={onOpenTrace}>
            Open the Test tab
          </Button>
        ) : null}
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
      {onHidePhiChange || onOpenTrace ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {onHidePhiChange ? (
            <div className="flex items-center gap-2">
              <Switch id={switchId} checked={hidePhi} onCheckedChange={(checked) => onHidePhiChange(checked === true)} />
              <Label htmlFor={switchId} className="text-xs font-normal">
                Hide PHI
              </Label>
            </div>
          ) : (
            <span />
          )}
          {onOpenTrace ? (
            <Button type="button" variant="link" size="sm" className="px-0" onClick={onOpenTrace}>
              Open full trace in Test
              <IconExternalLink aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
      {lastRun.error ? <p className="text-destructive text-sm">{hidePhi ? PHI_MASK : lastRun.error}</p> : null}
      <Values title="Inputs" values={lastRun.inputs} phi={phiFields?.inputs} hidePhi={hidePhi} />
      <Values title="Outputs" values={lastRun.outputs} phi={phiFields?.outputs} hidePhi={hidePhi} />
    </div>
  );
}
