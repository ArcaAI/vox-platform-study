import { Button } from '@arcaai/ui/button';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import type { PromptVersion, PromptVersionDiff } from '@arcaai/vox';
import { ArrowRight, RotateCcw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarizeDiff, summarizeFields, toDiffColumns, type DiffCell } from './diff-model';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function VersionSelect({
  id,
  label,
  value,
  onChange,
  versions,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  versions: PromptVersion[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id} className="w-32 font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.versionNumber} value={String(v.versionNumber)} className="font-mono">
              v{v.versionNumber}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DiffLine({ cell }: { cell: DiffCell }) {
  const tone =
    cell.kind === 'add'
      ? 'bg-success/10 text-success'
      : cell.kind === 'remove'
        ? 'bg-destructive/10 text-destructive'
        : cell.kind === 'empty'
          ? 'bg-muted/30'
          : '';
  const sign = cell.kind === 'add' ? '+' : cell.kind === 'remove' ? '−' : '';
  return (
    <div className={cn('flex gap-2 px-2 py-0.5', tone)}>
      <span className="w-8 shrink-0 select-none text-right text-muted-foreground tabular-nums">{cell.no ?? ''}</span>
      <span aria-hidden className="w-3 shrink-0 select-none">
        {sign}
      </span>
      <span className="whitespace-pre-wrap break-words">{cell.text || '\u00A0'}</span>
    </div>
  );
}

function DiffPane({ title, subtitle, cells }: { title: string; subtitle: string; cells: DiffCell[] }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <div className="max-h-[480px] overflow-auto font-mono text-xs leading-relaxed">
        {cells.map((cell, i) => (
          <DiffLine key={i} cell={cell} />
        ))}
      </div>
    </div>
  );
}

/**
 * Side-by-side version diff (frame 32). Two version selectors drive
 * `usePrompts.compareVersionsDetailed` → `PromptVersionDiff` (the server superset),
 * adapted into aligned columns by `toDiffColumns`. The per-field breakdown
 * (`content` vs `variables`) is surfaced as header chips (TASK-394 P0-2).
 * Additions/removals are toned with semantic `--success` / `--destructive` tokens
 * (plus +/− signs — never color-only).
 */
export function VersionDiff({
  versions,
  base,
  compare,
  onBaseChange,
  onCompareChange,
  diff,
  isLoading,
  error,
  onRetry,
}: {
  versions: PromptVersion[];
  base: number;
  compare: number;
  onBaseChange: (n: number) => void;
  onCompareChange: (n: number) => void;
  diff: PromptVersionDiff | null;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const baseVersion = versions.find((v) => v.versionNumber === base);
  const compareVersion = versions.find((v) => v.versionNumber === compare);
  const columns = diff ? toDiffColumns(diff) : null;
  const summary = diff ? summarizeDiff(diff) : null;
  const fields = diff ? summarizeFields(diff) : [];
  const sameVersion = base === compare;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-2">
          <VersionSelect id="diff-base" label="Base" value={base} onChange={onBaseChange} versions={sorted} />
          <ArrowRight aria-hidden className="mb-2.5 size-4 text-muted-foreground" />
          <VersionSelect id="diff-compare" label="Compare" value={compare} onChange={onCompareChange} versions={sorted} />
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm bg-success/30 ring-1 ring-success" />
            <span className="tabular-nums text-muted-foreground">+{summary?.additions ?? 0} added</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm bg-destructive/30 ring-1 ring-destructive" />
            <span className="tabular-nums text-muted-foreground">−{summary?.removals ?? 0} removed</span>
          </span>
        </div>
      </div>

      {!sameVersion && fields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="diff-field-breakdown">
          <span className="text-xs text-muted-foreground">Changed fields:</span>
          {fields.map((f) => (
            <span
              key={f.field}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
                f.changed ? 'border-primary/30 bg-primary/5' : 'border-border text-muted-foreground',
              )}
            >
              <span className="font-medium capitalize">{f.field}</span>
              {f.changed ? (
                <span className="tabular-nums">
                  <span className="text-success">+{f.additions}</span> <span className="text-destructive">−{f.removals}</span>
                </span>
              ) : (
                <span>unchanged</span>
              )}
            </span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-80 rounded-md" />
          <Skeleton className="h-80 rounded-md" />
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-md border p-10 text-center">
          <TriangleAlert className="size-9 text-destructive" />
          <div>
            <p className="font-medium">Couldn’t compute the diff</p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : sameVersion ? (
        <p className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">Select two different versions to compare.</p>
      ) : columns ? (
        <div className="grid gap-3 md:grid-cols-2">
          <DiffPane
            title={`Base · v${base}`}
            subtitle={`${fmtDate(baseVersion?.createdAt)}${baseVersion?.changedBy ? ` · ${baseVersion.changedBy}` : ''}`}
            cells={columns.left}
          />
          <DiffPane
            title={`Compare · v${compare}`}
            subtitle={`${fmtDate(compareVersion?.createdAt)}${compareVersion?.changedBy ? ` · ${compareVersion.changedBy}` : ''}`}
            cells={columns.right}
          />
        </div>
      ) : null}

      {compareVersion?.changeReason ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">v{compare} reason:</span> {compareVersion.changeReason}
        </p>
      ) : null}
    </div>
  );
}
