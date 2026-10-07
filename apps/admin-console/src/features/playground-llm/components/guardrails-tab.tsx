'use client';

import { useId, useState } from 'react';
import { IconShieldCheck, IconShieldSearch } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { GuardrailNoticeList } from '@/shared/guardrail/guardrail-notice-list';
import {
  guardrailActionTakenMeta,
  guardrailCategoryLabel,
  guardrailCheckLabel,
  guardrailDecisionMeta,
  guardrailVerdictLabel,
} from '@/shared/guardrail/labels';
import { toGuardrailNotices } from '@/shared/guardrail/notice';
import { useAnalyzeGuardrail, useScreenWithEffectiveRules } from '../api/hooks';
import { GUARDRAIL_TYPES, type EffectiveRulesScreenResult, type GuardrailAnalysis, type GuardrailType } from '../api/types';

const TYPE_LABELS: Record<GuardrailType, string> = {
  content_safety: 'Content safety',
  pii_detection: 'PII detection',
  prompt_injection: 'Prompt injection',
  comprehensive: 'Comprehensive',
};

/**
 * LLM Playground → Guardrails tab. Input → content-safety / PII /
 * prompt-injection verdict via the `safety-checks` gateway proxy. Runs
 * under the caller's own account (user-plane `@Authorize()`).
 */
export function GuardrailsTab() {
  return (
    <div className="flex flex-col gap-4">
      <FreeFormAnalyzer />
      <RulesTestCard />
    </div>
  );
}

/** The free-form analyzer (unchanged): content safety / PII / injection, NOT the tenant's rules. */
function FreeFormAnalyzer() {
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

const ACTION_LABELS: Record<string, string> = { ignore: 'Ignore', warn: 'Warn', block: 'Block' };

/**
 * TASK-1050 W3b — "Test my rules": screen text inbound or outbound under the tenant's EFFECTIVE guardrail
 * rules (platform action, tenant on/off, locks) and see every check's verdict, the configured action and
 * what would actually happen, plus the notices it would raise. Verdicts only — no content, no reasoning.
 * The route is a TODO seam (`api/guardrail-screen-client.ts`); a 404 says so instead of failing.
 */
function RulesTestCard() {
  const headingId = useId();
  const [text, setText] = useState('');
  const [direction, setDirection] = useState<'inbound' | 'outbound'>('inbound');
  const screenRules = useScreenWithEffectiveRules();
  const canRun = text.trim().length > 0 && !screenRules.isPending;
  const routeMissing = screenRules.error instanceof GatewayError && (screenRules.error.status === 404 || screenRules.error.status === 405);

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2 id={headingId} className="leading-none font-medium">
            Test my rules
          </h2>
          <CardDescription>Screens the text the way a real request is screened, under this tenant’s effective guardrail rules.</CardDescription>
        </CardHeader>
        <CardContent className="grid items-start gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-text`}>Text to screen</Label>
              <Textarea
                id={`${headingId}-text`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Paste a prompt (inbound) or a generated note (outbound)…"
                className="min-h-32 resize-none"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-direction`}>Direction</Label>
              <NativeSelect
                id={`${headingId}-direction`}
                className="w-56"
                value={direction}
                onChange={(event) => setDirection(event.target.value === 'outbound' ? 'outbound' : 'inbound')}
              >
                <NativeSelectOption value="inbound">Inbound (input to the model)</NativeSelectOption>
                <NativeSelectOption value="outbound">Outbound (generated content)</NativeSelectOption>
              </NativeSelect>
            </div>
            <Button className="self-start" disabled={!canRun} onClick={() => screenRules.mutate({ direction, text })}>
              {screenRules.isPending ? <Spinner /> : <IconShieldSearch aria-hidden />}
              Screen with my rules
            </Button>
          </div>
          <div aria-live="polite" className="flex min-w-0 flex-col gap-3">
            {screenRules.isPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : routeMissing ? (
              <p className="text-muted-foreground text-sm">
                Screening under the effective rules is not available on this gateway yet. The free-form analyzer above still works.
              </p>
            ) : screenRules.isError ? (
              <p className="text-destructive text-sm">{(screenRules.error as Error).message}</p>
            ) : screenRules.data ? (
              <RulesTestResult result={screenRules.data} />
            ) : (
              <p className="text-muted-foreground text-sm">Run a screen to see each check’s verdict and the action your rules take.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function RulesTestResult({ result }: { result: EffectiveRulesScreenResult }) {
  const decision = guardrailDecisionMeta(result.decision);
  const notices = toGuardrailNotices(result.notices ?? []);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={decision.label} colorRole={decision.role} />
        {result.policyVersion ? <span className="text-muted-foreground font-mono text-xs">{`policy ${result.policyVersion}`}</span> : null}
        {result.evaluationId ? <span className="text-muted-foreground font-mono text-xs">{`evaluation ${result.evaluationId}`}</span> : null}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table aria-label={`Checks (${result.checks.length})`} className="w-full min-w-[28rem] text-xs">
          <thead className="bg-muted/50 text-muted-foreground text-left">
            <tr>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Check
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Verdict
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Action
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Action taken
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Score
              </th>
              <th scope="col" className="px-2.5 py-1.5 font-semibold">
                Category
              </th>
            </tr>
          </thead>
          <tbody>
            {result.checks.map((check, index) => {
              const taken = guardrailActionTakenMeta(check.actionTaken);
              const checkName = check.name ?? check.checkId ?? `check ${index + 1}`;
              return (
                <tr key={`${checkName}-${index}`} className="border-t">
                  <td className="px-2.5 py-1.5">{guardrailCheckLabel(checkName)}</td>
                  <td className="px-2.5 py-1.5">{guardrailVerdictLabel(check.verdict)}</td>
                  <td className="px-2.5 py-1.5">{check.action ? (ACTION_LABELS[check.action] ?? check.action) : '—'}</td>
                  <td className="px-2.5 py-1.5">
                    <StatusBadge label={taken.label} colorRole={taken.role} />
                  </td>
                  <td className="px-2.5 py-1.5 tabular-nums">{typeof check.score === 'number' ? `${Math.round(check.score * 100)}%` : '—'}</td>
                  <td className="text-muted-foreground px-2.5 py-1.5">
                    <span className="flex flex-col">
                      <span>{check.category ? guardrailCategoryLabel(check.category) : '—'}</span>
                      {check.reason ? <span className="font-mono">{guardrailCategoryLabel(check.reason)}</span> : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <GuardrailNoticeList notices={notices} emptyText="No notices would be raised." />
    </div>
  );
}
