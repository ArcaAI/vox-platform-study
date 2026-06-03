import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { FlaskConical, Sparkles } from 'lucide-react';

import { useTestPrompt, type PromptTemplate, type PromptTestMetrics, type PromptTestResult } from '../api/prompts';

interface PromptTestPanelProps {
  tenantId: string;
  prompt: PromptTemplate;
}

function scoreTone(score: number): string {
  if (score >= 0.75) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
  if (score >= 0.4) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
  return 'bg-rose-500/15 text-rose-700 dark:text-rose-400';
}

/**
 * TASK-331 doc-02 F8 — render the deterministic sub-score breakdown so the
 * percentage reads as an honest coverage/quality proxy rather than an opaque,
 * clinical-looking score. Only shown for a fresh run (metrics aren't persisted).
 */
function MetricsBreakdown({ metrics }: { metrics: PromptTestMetrics }) {
  const items: { label: string; value: string }[] = [
    { label: 'Length', value: `${Math.round(metrics.lengthScore * 100)}% (${metrics.wordCount} words)` },
    {
      label: 'JSON',
      value: metrics.jsonExpected ? (metrics.jsonValid ? 'valid' : 'invalid') : 'n/a',
    },
    {
      label: 'Variable coverage',
      value: metrics.variableCoverage === null ? 'n/a' : `${Math.round(metrics.variableCoverage * 100)}% of ${metrics.variablesDeclared}`,
    },
  ];

  return (
    <dl className="grid grid-cols-1 gap-1 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="bg-muted/40 flex flex-col rounded-md px-2 py-1.5">
          <dt className="text-muted-foreground text-[10px] uppercase tracking-wide">{item.label}</dt>
          <dd className="text-xs font-medium">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * TASK-328 A4 / TASK-331 doc-02 F8 — runs the template against the
 * SMR/text-generation service and shows a DETERMINISTIC output-quality proxy
 * (not a semantic/clinical judgement) plus the generated output. Relabelled
 * "Output Check" and accompanied by a per-dimension breakdown so the
 * percentage is read honestly. The mutation is OCC-guarded (`expectedVersion`
 * + `If-Match`) exactly like the edit flow.
 */
export function PromptTestPanel({ tenantId, prompt }: PromptTestPanelProps) {
  const testMutation = useTestPrompt(tenantId);
  const [result, setResult] = useState<PromptTestResult | null>(null);

  // Fall back to the last persisted run so the panel isn't empty after a
  // refresh/navigation.
  const score = result?.score ?? prompt.lastTestScore ?? null;
  const output = result?.output ?? prompt.lastTestOutput ?? null;
  const testedAt = result?.testedAt ?? prompt.lastTestAt ?? null;
  const metrics = result?.metrics ?? null;

  const handleRun = () => {
    testMutation.mutate(
      {
        id: prompt.id,
        expectedVersion: prompt.version,
        ifMatch: prompt.version != null ? `"${prompt.version}"` : undefined,
      },
      {
        onSuccess: (data) => {
          setResult(data);
          toast.success(`Output check complete — proxy score ${Math.round(data.score * 100)}%`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Prompt test failed');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="size-4" /> Output Check
        </h4>
        <Button size="sm" onClick={handleRun} disabled={testMutation.isPending}>
          {testMutation.isPending ? 'Running…' : 'Run Test'}
        </Button>
      </div>

      {testMutation.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : score != null && output != null ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge className={scoreTone(score)}>
              <Sparkles className="mr-1 size-3" />
              {Math.round(score * 100)}%
            </Badge>
            <span className="text-muted-foreground text-xs">quality proxy</span>
            {testedAt && (
              <span className="text-muted-foreground text-xs">
                · {new Date(testedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          {metrics && <MetricsBreakdown metrics={metrics} />}
          <pre className="bg-muted/40 max-h-64 overflow-auto whitespace-pre-wrap rounded-md p-3 text-sm">{output}</pre>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No test has been run yet. Click "Run Test" to score this prompt against the text-generation service.
        </p>
      )}
    </div>
  );
}
