'use client';

/**
 * TASK-965 §3.1 point 7 / OD-965-7 — "Compare with previous", the minimum diff affordance a
 * versioned-item screen owes an admin who is about to roll back.
 *
 * The activate confirm names the CONSEQUENCE ("v3 stops serving, 2 assignments follow"); only a
 * diff answers the other half, "is v2 the version I mean". Both bodies are already in hand from
 * the versions route, so the whole comparison is client-side and this dialog never fetches.
 *
 * **Why not `CodeEditor`.** `@arcaai/ui`'s `CodeEditor` is the console's JSON surface, but it
 * tokenises ONE document into a single highlighted `<pre>` behind a textarea — it has no notion
 * of a second document and no per-line tint, so a diff rendered in it would be two JSON blobs and
 * an admin doing the comparison by eye. This dialog renders its own read-only two-pane / unified
 * view over `diffLines` instead, keeping the editor's mono type and line gutter so the two
 * surfaces still read as one family.
 *
 * Every changed line carries a `+` / `−` prefix in BOTH modes, not only a background tint:
 * colour alone would fail WCAG 1.4.1, and the tint is also the first thing lost when a screenshot
 * of the diff is pasted into a ticket.
 */
import { useMemo, useState } from 'react';
import { IconArrowsDiff } from '@tabler/icons-react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from '@arcaai/ui';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';
import { diffLines, toComparableJson, type DiffLine } from './line-diff';

export type VersionCompareMode = 'split' | 'unified';

export interface VersionComparePayload {
  /** How this side is named in the UI — "v2", "Draft v4", "Published 2 Mar". */
  label: string;
  /** The version body. A string is compared as text; anything else as stable-key JSON. */
  value: unknown;
}

export interface VersionCompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The older side. */
  from: VersionComparePayload;
  /** The newer side. */
  to: VersionComparePayload;
  title?: string;
  description?: string;
  defaultMode?: VersionCompareMode;
}

const MARKER: Record<DiffLine['kind'], string> = { added: '+', removed: '−', context: ' ' };

const LINE_CLASS: Record<DiffLine['kind'], string> = {
  added: 'bg-success/15',
  removed: 'bg-destructive/15',
  context: '',
};

function DiffLineRow({ line, lineNumber }: { line: DiffLine; lineNumber: number | null }) {
  return (
    <div className={cn('flex gap-2 px-2', LINE_CLASS[line.kind])}>
      <span aria-hidden className="text-muted-foreground w-8 shrink-0 text-right tabular-nums select-none">
        {lineNumber ?? ''}
      </span>
      <span className="w-3 shrink-0 select-none">{MARKER[line.kind]}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap">{line.text}</span>
    </div>
  );
}

function DiffPane({ label, lines, side }: { label: string; lines: DiffLine[]; side: 'from' | 'to' }) {
  const shown = lines.filter((line) => (side === 'from' ? line.kind !== 'added' : line.kind !== 'removed'));
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground font-mono text-xs">{label}</span>
      <div className="bg-muted/30 min-h-0 flex-1 overflow-auto rounded-md border py-2 font-mono text-xs">
        {shown.map((line, index) => (
          <DiffLineRow key={index} line={line} lineNumber={side === 'from' ? line.fromLine : line.toLine} />
        ))}
      </div>
    </section>
  );
}

export function VersionCompareDialog({
  open,
  onOpenChange,
  from,
  to,
  title = 'Compare versions',
  description,
  defaultMode = 'split',
}: VersionCompareDialogProps) {
  const [mode, setMode] = useState<VersionCompareMode>(defaultMode);
  const diff = useMemo(() => diffLines(toComparableJson(from.value), toComparableJson(to.value)), [from.value, to.value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_SIZE_CLASS.lg}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? `${from.label} compared with ${to.label}. Both sides are read-only; nothing here changes what is served.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-success tabular-nums">
            +{diff.stats.additions}
          </Badge>
          <Badge variant="outline" className="text-destructive tabular-nums">
            {'−'}
            {diff.stats.deletions}
          </Badge>
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant={mode === 'split' ? 'secondary' : 'ghost'} aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
              Split
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'unified' ? 'secondary' : 'ghost'}
              aria-pressed={mode === 'unified'}
              onClick={() => setMode('unified')}
            >
              Unified
            </Button>
          </span>
        </div>

        {diff.truncated ? (
          <Alert>
            <IconArrowsDiff aria-hidden />
            <AlertDescription>
              These versions are too large to compare line by line, so each side is shown whole. Export both versions to diff them locally.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {diff.identical ? (
            <Alert>
              <IconArrowsDiff aria-hidden />
              <AlertDescription>
                {from.label} and {to.label} are identical — every field matches, including key order once both are normalised.
              </AlertDescription>
            </Alert>
          ) : mode === 'split' ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-2">
              <DiffPane label={from.label} lines={diff.lines} side="from" />
              <DiffPane label={to.label} lines={diff.lines} side="to" />
            </div>
          ) : (
            <section aria-label={`${from.label} compared with ${to.label}`} className="flex min-h-0 flex-1 flex-col">
              <div className="bg-muted/30 min-h-0 flex-1 overflow-auto rounded-md border py-2 font-mono text-xs">
                {diff.lines.map((line, index) => (
                  <DiffLineRow key={index} line={line} lineNumber={line.toLine ?? line.fromLine} />
                ))}
              </div>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
