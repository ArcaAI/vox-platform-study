/**
 * TASK-395 P1-3 (§5.1 · `24b`) — SUBJECTS × ACTIONS permission matrix.
 *
 * Renders a single policy's CASL `rules` as a grid: allow ✓ (teal) · deny ✕ (red,
 * from an `inverted` "cannot" rule) · conditional • (amber, the allow carries
 * `conditions`). `manage` expands across every action column; the `all` subject is
 * shown as its own wildcard row. Pure/derived — no mutations, no SDK calls.
 */
import { useMemo } from 'react';
import { Check, Dot, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cellState, MATRIX_ACTIONS, normalizeRules, ruleSubjects, ruleSummary, type CellState } from './abilities';

function MatrixCell({ state, label }: { state: CellState; label: string }) {
  if (state === 'allow') return <Check className="mx-auto size-4 text-primary" aria-label={`${label}: allowed`} />;
  if (state === 'deny') return <X className="mx-auto size-4 text-destructive" aria-label={`${label}: denied`} />;
  if (state === 'conditional') return <Dot className="mx-auto size-5 text-warning" aria-label={`${label}: conditional`} />;
  return <Minus className="mx-auto size-3 text-muted-foreground/40" aria-label={`${label}: not granted`} />;
}

export function PermissionMatrix({ rules }: { rules: unknown }) {
  const normalized = useMemo(() => normalizeRules(rules), [rules]);
  const subjects = useMemo(() => ruleSubjects(normalized), [normalized]);
  const summary = useMemo(() => ruleSummary(normalized), [normalized]);

  if (subjects.length === 0) {
    return <p className="text-sm text-muted-foreground">No structured CASL rules to visualize.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {summary.total} rule{summary.total === 1 ? '' : 's'}
        </span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{summary.deny} deny</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{summary.conditional} conditional</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5 text-primary" /> allow
          </span>
          <span className="inline-flex items-center gap-1">
            <X className="size-3.5 text-destructive" /> deny
          </span>
          <span className="inline-flex items-center gap-1">
            <Dot className="size-4 text-warning" /> conditional
          </span>
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Subject
              </th>
              {MATRIX_ACTIONS.map((action) => (
                <th key={action} scope="col" className="px-2 py-2 text-center text-xs font-medium capitalize text-muted-foreground">
                  {action}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {subjects.map((subject) => (
              <tr key={subject} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-mono text-xs">{subject}</td>
                {MATRIX_ACTIONS.map((action) => (
                  <td key={action} className={cn('px-2 py-2 text-center')}>
                    <MatrixCell state={cellState(normalized, subject, action)} label={`${subject} ${action}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
