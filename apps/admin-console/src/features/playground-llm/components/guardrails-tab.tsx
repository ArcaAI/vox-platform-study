'use client';

import { useState } from 'react';
import { IconShieldCheck } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { useAnalyzeGuardrail } from '../api/hooks';
import { GUARDRAIL_TYPES, type GuardrailAnalysis, type GuardrailType } from '../api/types';

const TYPE_LABELS: Record<GuardrailType, string> = {
  content_safety: 'Content safety',
  pii_detection: 'PII detection',
  prompt_injection: 'Prompt injection',
  comprehensive: 'Comprehensive',
};

/**
 * Agent Playground → Guardrails tab. Input → content-safety / PII /
 * prompt-injection verdict via the `ai/guardrail/analyze` gateway proxy. Runs
 * under the caller's own account (user-plane `@Authorize()`).
 */
export function GuardrailsTab() {
  const [text, setText] = useState('');
  const [type, setType] = useState<GuardrailType>('comprehensive');
  const analyze = useAnalyzeGuardrail();
  const canRun = text.trim().length > 0 && !analyze.isPending;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Analyze text</CardTitle>
          <CardDescription>Checks content safety, PII, and prompt injection against the tenant guardrail engine.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gr-text">Text</Label>
            <Textarea
              id="gr-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste text to check…"
              className="min-h-40 resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gr-type">Check type</Label>
            <NativeSelect id="gr-type" className="w-56" value={type} onChange={(event) => setType(event.target.value as GuardrailType)}>
              {GUARDRAIL_TYPES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {TYPE_LABELS[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button className="self-start" disabled={!canRun} onClick={() => analyze.mutate({ text, guardrailType: type })}>
            {analyze.isPending ? <Spinner /> : <IconShieldCheck aria-hidden />}
            Analyze
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verdict</CardTitle>
        </CardHeader>
        <CardContent>
          {analyze.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : analyze.isError ? (
            <p className="text-destructive text-sm">{(analyze.error as Error).message}</p>
          ) : analyze.data ? (
            <GuardrailVerdict data={analyze.data} />
          ) : (
            <p className="text-muted-foreground text-sm">Run an analysis to see the safety verdict.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GuardrailVerdict({ data }: { data: GuardrailAnalysis }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={data.safe ? 'Safe' : 'Unsafe'} colorRole={data.safe ? 'success' : 'destructive'} />
        <span className="text-muted-foreground text-xs">confidence {Math.round((data.confidence ?? 0) * 100)}%</span>
      </div>
      {data.issues.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Issues ({data.issues.length})</p>
          <ul className="text-foreground list-disc pl-5 text-sm">
            {data.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No issues detected.</p>
      )}
      {data.error ? <p className="text-destructive text-xs">{data.error}</p> : null}
    </div>
  );
}
