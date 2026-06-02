import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { FlaskConical, Sparkles } from 'lucide-react';

import { useTestPrompt, type PromptTemplate, type PromptTestResult } from '../api/prompts';

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
 * TASK-328 A4 — runs the template against the SMR/text-generation service
 * and shows the resulting quality score + generated output. The mutation is
 * OCC-guarded (`expectedVersion` + `If-Match`) exactly like the edit flow.
 */
export function PromptTestPanel({ tenantId, prompt }: PromptTestPanelProps) {
  const testMutation = useTestPrompt(tenantId);
  const [result, setResult] = useState<PromptTestResult | null>(null);

  // Fall back to the last persisted run so the panel isn't empty after a
  // refresh/navigation.
  const score = result?.score ?? prompt.lastTestScore ?? null;
  const output = result?.output ?? prompt.lastTestOutput ?? null;
  const testedAt = result?.testedAt ?? prompt.lastTestAt ?? null;

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
          toast.success(`Test complete — score ${Math.round(data.score * 100)}%`);
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
          <FlaskConical className="size-4" /> Quality Test
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
            {testedAt && (
              <span className="text-muted-foreground text-xs">
                {new Date(testedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <pre className="bg-muted/40 max-h-64 overflow-auto whitespace-pre-wrap rounded-md p-3 text-sm">{output}</pre>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No test has been run yet. Click "Run Test" to score this prompt against the text-generation service.</p>
      )}
    </div>
  );
}
