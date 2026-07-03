import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared';
import { Textarea } from '@arcaai/ui/textarea';
import type { PromptTemplate } from '@arcaai/vox';
import type { PromptTestResult } from './sdk-types';
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatScore, normalizeMetrics, scorePercent, scoreToneRole } from './playground-format';

/** Score-tone → explicit token utilities (kept static so Tailwind keeps them). */
const SCORE_TEXT: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  neutral: 'text-foreground',
};
const SCORE_BAR: Record<string, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  neutral: 'bg-muted-foreground/40',
};

function toneText(role: StatusColorRole): string {
  return SCORE_TEXT[role] ?? 'text-foreground';
}
function toneBar(role: StatusColorRole): string {
  return SCORE_BAR[role] ?? 'bg-muted-foreground/40';
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Meter({ percent, role }: { percent: number; role: StatusColorRole }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div className={cn('h-full rounded-full transition-[width]', toneBar(role))} style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * Test Playground body (frame 33). The Run/Reset actions live in the workspace
 * header (route-owned, like the editor), so this is a fully-controlled body:
 * left = sample input + per-`{{variable}}` values; right = the SMR-scored output.
 * The headline `score` is REAL (`usePrompts.test` → quality proxy in [0,1]); the
 * per-metric breakdown is a **TARGET** — only rendered if a future backend returns
 * a `metrics` map, otherwise framed honestly as an SMR quality proxy.
 */
export function TestPlayground({
  prompt,
  variableNames,
  values,
  onValueChange,
  sampleInput,
  onSampleInputChange,
  onLoadExample,
  result,
  isRunning,
  error,
  canManage,
}: {
  prompt: PromptTemplate;
  variableNames: string[];
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
  sampleInput: string;
  onSampleInputChange: (value: string) => void;
  onLoadExample: () => void;
  result: PromptTestResult | null;
  isRunning: boolean;
  error?: Error | null;
  canManage: boolean;
}) {
  const scoreRole = result ? scoreToneRole(result.score) : 'neutral';
  // TARGET: `PromptTestResult` has no `metrics` field today — render the breakdown
  // only if a future backend supplies it (never fabricated here).
  const metrics = normalizeMetrics((result as { metrics?: Record<string, number> } | null)?.metrics);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="flex flex-col rounded-lg border bg-card" aria-label="Sample input">
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sample input</span>
          {canManage ? (
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={onLoadExample}>
              Load example
            </Button>
          ) : null}
        </header>
        <div className="space-y-4 p-4">
          <Textarea
            aria-label="Sample input"
            value={sampleInput}
            onChange={(e) => onSampleInputChange(e.target.value)}
            readOnly={!canManage}
            spellCheck={false}
            className="min-h-[220px] resize-y font-mono text-xs leading-relaxed"
            placeholder="Paste a sample transcript or context to run the instruction against…"
          />
          <div className="space-y-2">
            <Label className="text-muted-foreground">Resolved variables</Label>
            {variableNames.length === 0 ? (
              <p className="text-xs text-muted-foreground">No {`{{variables}}`} detected in this instruction.</p>
            ) : (
              <div className="space-y-2">
                {variableNames.map((name) => (
                  <div key={name} className="grid grid-cols-[minmax(0,150px)_1fr] items-center gap-2">
                    <span className="truncate font-mono text-xs text-muted-foreground" title={`{{${name}}}`}>
                      {`{{${name}}}`}
                    </span>
                    <Input
                      aria-label={`Value for ${name}`}
                      value={values[name] ?? ''}
                      onChange={(e) => onValueChange(name, e.target.value)}
                      readOnly={!canManage}
                      placeholder="value"
                      className="h-9"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="flex flex-col rounded-lg border bg-card" aria-label="Output">
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</span>
          {isRunning ? <StatusBadge label="Running" colorRole="info" /> : result ? <StatusBadge label="Completed" colorRole="success" /> : null}
        </header>
        <div className="flex-1 space-y-4 p-4">
          {isRunning ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-md border p-8 text-center">
              <TriangleAlert className="size-8 text-destructive" />
              <div>
                <p className="font-medium">Test run failed</p>
                <p className="text-sm text-muted-foreground">{error.message}</p>
              </div>
            </div>
          ) : result ? (
            <>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.output}</p>

              <div className="space-y-3 rounded-md border bg-muted/30 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Evaluation</span>
                  <span className="text-xs text-muted-foreground">SMR quality proxy</span>
                </div>
                <div className="flex items-end gap-3">
                  <span className={cn('text-3xl font-semibold tabular-nums', toneText(scoreRole))}>{formatScore(result.score)}</span>
                  <div className="flex-1 space-y-1 pb-1">
                    <Meter percent={scorePercent(result.score)} role={scoreRole} />
                    <p className="text-xs text-muted-foreground">Overall quality</p>
                  </div>
                </div>

                {metrics.length > 0 ? (
                  <ul className="space-y-2 border-t pt-3">
                    {metrics.map((m) => (
                      <li key={m.key} className="grid grid-cols-[minmax(0,120px)_1fr_auto] items-center gap-3">
                        <span className="truncate text-sm text-muted-foreground">{m.label}</span>
                        <Meter percent={m.percent} role={m.role} />
                        <span className="text-sm tabular-nums text-muted-foreground">{formatScore(m.value)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t pt-3 text-xs text-muted-foreground">
                    Per-metric breakdown (faithfulness · coverage · conciseness) is a target — the headline score is an honest SMR quality proxy.
                  </p>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Sandbox run — never written to a patient record{result.testedAt ? ` · ${fmtTime(result.testedAt)}` : ''}.
              </p>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
              <FlaskConical className="size-9 text-muted-foreground" />
              <p className="font-medium">No test run yet</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Provide sample input and run the instruction to validate it against the SMR service before publishing.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
