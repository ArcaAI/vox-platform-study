'use client';

/**
 * TASK-890 §3.8 — the draft-agent test bench: `POST admin/agents/:id/test` (dry by default) +
 * `:id/test/finalize`. A dry run assembles and returns the exact prompts and the resolved
 * `{provider, model, fundingTier}` WITHOUT generating anything or spending a token; a live run
 * streams through the same `text-generations/tasks/:id/stream` transport the prompt-template test
 * bench uses (`useTaskStream`) and finalizes server-side by `taskId`, which is what actually
 * writes the `generate.stream` usage row with `trigger: AGENT_TEST`. Only DRAFT/VALIDATED agents
 * reach this panel — a PUBLISHED row is INVOKED (`POST /agents/{slug}/invocations`), not tested.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Field, FieldContent, FieldDescription, FieldLabel, Skeleton, Spinner, Switch, Textarea } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { useTaskStream } from '@/shared/streams';
import { useFinalizeAgentTest, useTestAgent } from '../api';
import type { Agent, AgentFinding, AgentTestAck, AgentTestResult } from '../api';
import { JsonField } from './json-field';

export interface DraftTestPanelProps {
  agent: Agent;
}

/** A blocking 400 carries the SAME findings the ack does — render it the same way rather than as a toast-only failure. */
function findingsFromError(error: unknown): AgentFinding[] | null {
  if (!(error instanceof GatewayError)) return null;
  const body = error.details as { findings?: AgentFinding[] } | undefined;
  return body?.findings?.length ? body.findings : null;
}

export function DraftTestPanel({ agent }: DraftTestPanelProps) {
  const [inputText, setInputText] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<Record<string, unknown> | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [ack, setAck] = useState<AgentTestAck | null>(null);
  const [findings, setFindings] = useState<AgentFinding[] | null>(null);
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  const runTest = useTestAgent();
  const finalize = useFinalizeAgentTest();
  const stream = useTaskStream(taskId);
  const finalizedRef = useRef<string | null>(null);
  const notifiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!taskId || stream.status !== 'done' || finalizedRef.current === taskId) return;
    finalizedRef.current = taskId;
    finalize.mutate(
      { id: agent.id, body: { taskId } },
      { onSuccess: setResult, onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not read the run back.') },
    );
  }, [taskId, stream.status, agent.id, finalize]);

  useEffect(() => {
    if (!taskId || (stream.status !== 'failed' && stream.status !== 'error') || notifiedRef.current === taskId) return;
    notifiedRef.current = taskId;
    toast.error(stream.error ?? 'The test run stream failed.');
  }, [taskId, stream.status, stream.error]);

  const streaming = !!taskId && (stream.status === 'connecting' || stream.status === 'streaming');
  const running = runTest.isPending || streaming || finalize.isPending;

  function run() {
    setAck(null);
    setFindings(null);
    setResult(null);
    setTaskId(null);
    finalize.reset();
    runTest.mutate(
      { id: agent.id, body: { input: { text: inputText }, ...(variables ? { variables } : {}), ...(context ? { context } : {}), dryRun } },
      {
        onSuccess: (received) => {
          setAck(received);
          if (received.findings.length) setFindings(received.findings);
          if (received.mode === 'stream' && received.taskId) setTaskId(received.taskId);
        },
        onError: (error) => {
          const blocking = findingsFromError(error);
          if (blocking) {
            setFindings(blocking);
            return;
          }
          toast.error(error instanceof GatewayError ? error.message : 'The test run failed.');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="draft-test-input">Input text</FieldLabel>
        <Textarea id="draft-test-input" rows={4} value={inputText} onChange={(event) => setInputText(event.target.value)} />
      </div>
      <JsonField label="Context" description="Validated against the agent's bound context schema, when it pins one." value={context} onChange={setContext} rows={4} />
      <JsonField label="Variable overrides" description="Overlays the agent's own instruction bindings — these win." value={variables} onChange={setVariables} rows={4} />

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="draft-test-dry-run">Dry run</FieldLabel>
          <FieldDescription>
            {dryRun ? 'Assembles the prompt only — nothing is generated, nothing is billed.' : "This run counts against the tenant's monthly LLM token allowance."}
          </FieldDescription>
        </FieldContent>
        <Switch id="draft-test-dry-run" checked={dryRun} onCheckedChange={setDryRun} />
      </Field>

      <Button type="button" className="self-start" disabled={running} onClick={run}>
        {running ? <Spinner /> : null}
        Run
      </Button>

      {findings?.length ? (
        <ul className="flex flex-col gap-1" aria-label="Findings">
          {findings.map((finding, index) => (
            <li key={`${finding.path}-${index}`} className="flex items-start gap-2 text-sm">
              <Badge variant={finding.severity === 'ERROR' ? 'destructive' : 'secondary'}>{finding.code}</Badge>
              <span>
                <span className="font-mono text-xs">{finding.path}</span> — {finding.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {ack ? (
        <div className="flex flex-col gap-2">
          {ack.assembledSystemPrompt ? (
            <div>
              <h4 className="text-sm font-medium">Assembled system prompt</h4>
              <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{ack.assembledSystemPrompt}</pre>
            </div>
          ) : null}
          <div>
            <h4 className="text-sm font-medium">Assembled user prompt</h4>
            <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{ack.assembledUserPrompt || '—'}</pre>
          </div>
          <p className="text-muted-foreground text-xs">
            Resolved:{' '}
            <span className="font-mono">
              {ack.resolved.provider}/{ack.resolved.model}
            </span>{' '}
            · {ack.resolved.fundingTier} funding
          </p>
          {ack.composition ? (
            <p className="text-muted-foreground text-xs">
              Fragments — selected: <span className="font-mono">{ack.composition.selected.join(', ') || '—'}</span>
              {ack.composition.excluded.length ? (
                <>
                  {' '}
                  · excluded:{' '}
                  <span className="font-mono">{ack.composition.excluded.map((excluded) => `${excluded.key} (${excluded.reason})`).join(', ')}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      {streaming ? <Skeleton className="h-16 w-full" /> : null}
      {stream.content ? <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{stream.content}</pre> : null}
      {result ? (
        <p className="text-muted-foreground text-xs">
          {result.usage ? `${result.usage.totalTokens} tokens · ` : ''}served by {result.provider}/{result.model}
        </p>
      ) : null}
    </div>
  );
}
