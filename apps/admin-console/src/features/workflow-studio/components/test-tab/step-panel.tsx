'use client';

/**
 * The Test tab's Step panel (TASK-1036 §10.2): the selected step at the moment the view shows —
 * its pinned agent, each input as `field ← source = resolved value` (an optional input that
 * rendered empty says so), its outputs streaming live, and what it asked of the model and the
 * guardrails.
 */
import { Badge } from '@arcaai/ui';
import type { NodeView } from '@/shared/sandbox/api/run-fold';
import { NodeGuardrailBadge } from '@/shared/sandbox/components/run-guardrail-summary';
import type { BindingSource } from '@/shared/sandbox/api/run-protocol';
import { formatDuration, formatValue } from './lib/event-display';
import { nodeWarningCount } from './lib/flow-state';
import { PHI_MASK } from './lib/phi';
import { Panel } from './panel';
import { nodeTypeTitle } from '../../lib/node-identity';

export interface StepPanelNode {
  id: string;
  type: string;
  label: string;
  /** `core.agent`: the agent and its pinned version (`null` = the active version at publish). */
  agent?: { slug: string | null; versionNumber: number | null };
}

const STATUS_TEXT: Record<NodeView['status'], string> = {
  waiting: 'Waiting',
  running: 'In progress',
  completed: 'Done',
  degraded: 'Done with warnings',
  failed: 'Failed',
  skipped: 'Skipped',
};

const STATUS_VARIANT: Record<NodeView['status'], 'outline' | 'secondary' | 'default' | 'destructive'> = {
  waiting: 'outline',
  running: 'secondary',
  completed: 'default',
  degraded: 'secondary',
  failed: 'destructive',
  skipped: 'outline',
};

function SourceText({ source }: { source: BindingSource | undefined }) {
  if (!source) return <span className="text-muted-foreground">unknown source</span>;
  if (source.kind === 'value') return <span className="text-muted-foreground">a fixed value</span>;
  if (source.kind === 'template') return <code className="font-mono text-xs break-all">{source.template ?? 'template'}</code>;
  return <code className="font-mono text-xs break-all">{source.path ?? '?'}</code>;
}

function Value({ value, hidePhi }: { value: unknown; hidePhi: boolean }) {
  return <span className="font-mono text-xs break-words">{hidePhi ? PHI_MASK : formatValue(value, 400)}</span>;
}

export function StepPanel({ node, run, hidePhi, live }: { node: StepPanelNode | null; run: NodeView | undefined; hidePhi: boolean; live: boolean }) {
  if (!node) {
    return (
      <Panel title="Step">
        <p className="text-muted-foreground text-sm">Select a step on the flow to see what it received and produced.</p>
      </Panel>
    );
  }
  const status = run?.status ?? 'waiting';
  const warnings = run ? nodeWarningCount(run) : 0;
  const outputs = Object.entries(run?.outputs ?? {});

  return (
    <Panel
      title={
        <>
          Step · <span>{node.label}</span>
        </>
      }
      actions={
        <>
          <Badge variant={STATUS_VARIANT[status]}>{STATUS_TEXT[status]}</Badge>
          <NodeGuardrailBadge node={run} />
          {run?.durationMs !== undefined && status !== 'running' ? (
            <span className="text-muted-foreground text-xs tabular-nums">{formatDuration(run.durationMs)}</span>
          ) : null}
          {run && run.attempt > 1 ? <span className="text-muted-foreground text-xs">Attempt {run.attempt}</span> : null}
        </>
      }
    >
      {node.agent ? (
        <p className="text-muted-foreground text-xs">
          Agent{' '}
          <span className="text-foreground font-mono">
            {node.agent.slug ?? 'not chosen'}
            {node.agent.versionNumber !== null ? ` · v${node.agent.versionNumber}` : ''}
          </span>{' '}
          {node.agent.versionNumber !== null ? '(pinned)' : '(active version at publish)'} · its prompt follows the agent’s pin.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{nodeTypeTitle(node.type)}</p>
      )}

      {!run ? (
        <p className="text-muted-foreground text-sm">{live ? 'This step has not run yet.' : 'This step had not run at this point.'}</p>
      ) : (
        <>
          {run.error ? (
            <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
              <p className="font-medium">
                {run.error.code} — {run.error.message}
                {run.willRetry ? ' Retrying.' : ''}
              </p>
              {run.error.detail ? <p className="mt-1 font-mono text-xs break-words">{hidePhi ? PHI_MASK : run.error.detail}</p> : null}
            </div>
          ) : null}

          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">Inputs</h3>
            {run.inputs.length === 0 ? (
              <p className="text-muted-foreground text-xs">{run.status === 'running' ? 'Resolving inputs…' : 'No inputs were bound.'}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {run.inputs.map((input) => (
                  <li key={input.input} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <code className="font-mono text-xs font-medium">{input.input}</code>
                    <span aria-hidden="true">←</span>
                    <span className="sr-only">from</span>
                    <SourceText source={input.source} />
                    <span aria-hidden="true">=</span>
                    <span className="sr-only">resolved to</span>
                    {input.empty ? (
                      <span className="text-muted-foreground text-xs italic">optional, rendered empty</span>
                    ) : (
                      <Value value={input.value} hidePhi={hidePhi} />
                    )}
                    {input.phiClass === 'PHI' ? (
                      <Badge variant="outline" className="text-[11px]">
                        PHI
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">Outputs</h3>
            {outputs.length === 0 ? (
              <p className="text-muted-foreground text-xs">{run.status === 'running' ? 'Waiting for output…' : 'No outputs.'}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {outputs.map(([field, value]) => (
                  <li key={field} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <code className="font-mono text-xs font-medium">{field}</code>
                    <span aria-hidden="true">=</span>
                    <Value value={value} hidePhi={hidePhi} />
                    {run.streaming.includes(field) ? (
                      <Badge variant="secondary" className="text-[11px]">
                        streaming
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {run.modelRequests.length > 0 || run.prompt || run.guardrails.length > 0 || run.tokens ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">Model and guardrails</h3>
              <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                {run.prompt ? (
                  <li>
                    Prompt: {run.prompt.layers.length} layer{run.prompt.layers.length === 1 ? '' : 's'},{' '}
                    {run.prompt.charsTotal.toLocaleString('en-US')} characters
                    {run.prompt.tokensTotal !== undefined ? `, ${run.prompt.tokensTotal.toLocaleString('en-US')} tokens` : ''}
                  </li>
                ) : null}
                {run.modelRequests.map((request, index) => (
                  <li key={`${request.provider}-${request.model}-${index}`}>
                    Model: {request.provider} · {request.model} (attempt {request.attempt}
                    {request.fallback ? ', fallback' : ''})
                  </li>
                ))}
                {run.guardrails.map((check) => (
                  <li key={check.seq}>
                    {check.direction === 'inbound' ? 'Inbound' : 'Outbound'} guardrail: {check.action}, {check.detected} finding
                    {check.detected === 1 ? '' : 's'}
                  </li>
                ))}
                {run.tokens ? (
                  <li className="tabular-nums">
                    Tokens: {run.tokens.in.toLocaleString('en-US')} in, {run.tokens.out.toLocaleString('en-US')} out
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {warnings > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">Warnings ({warnings})</h3>
              <ul className="text-warning-strong flex flex-col gap-1 text-xs">
                {run.bindingWarnings.map((warning, index) => (
                  <li key={`${warning.input}-${index}`}>
                    <code className="font-mono">{warning.input}</code>: {warning.message}
                  </li>
                ))}
                {run.outputChecks
                  .filter((check) => !check.valid)
                  .map((check, index) => (
                    <li key={`check-${index}`}>
                      {check.field ?? 'Output'} does not match its contract{hidePhi ? '' : `: ${check.problems[0] ?? ''}`}
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </Panel>
  );
}
