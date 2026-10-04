'use client';

/**
 * The Test tab's Execution context (TASK-1036 §10.2), four views of the run at the moment the view
 * shows:
 *
 * - **Session** — the consultation items building up: audio, transcript, entities, and each AI
 *   step's text (with an AI badge);
 * - **Context** — the run input against the workflow's Input shape, and whether it validated;
 * - **Consultation** — every consultation field a step read, tagged "read by <step> at +t";
 * - **Run & variables** — id, status, version, elapsed, tokens and the declared variables.
 *
 * PHI is shown to admins (the trace read is audited) with a one-click "Hide PHI".
 */
import { Badge, Label, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui';
import { useId, type ReactNode } from 'react';
import type { RunView } from '@/shared/sandbox/api/run-fold';
import { formatDuration, formatValue, relativeTime } from './lib/event-display';
import { PHI_MASK } from './lib/phi';
import { Panel } from './panel';

export interface ContextKindRow {
  key: string;
  label: string;
  primitive: string;
  phi: boolean;
}

export interface ExecutionContextProps {
  view: RunView;
  labelOf: (nodeId: string) => string;
  /** Graph node id → whether the step is an AI text step (its text is a generated note). */
  isAiTextStep: (nodeId: string) => boolean;
  /** Graph node ids of `core.variable` steps. */
  variableStepIds: readonly string[];
  kinds: readonly ContextKindRow[];
  /** What this tab sent as the run input (`null` for a resumed run whose input it never saw). */
  sentInput: Record<string, unknown> | null;
  recording: 'live' | 'ended' | null;
  hidePhi: boolean;
  onHidePhiChange: (hide: boolean) => void;
  elapsedMs: number | null;
}

function Masked({ value, hidePhi, plain = false }: { value: unknown; hidePhi: boolean; plain?: boolean }) {
  if (hidePhi) return <span className="font-mono text-xs">{PHI_MASK}</span>;
  if (plain && typeof value === 'string') return <span className="break-words whitespace-pre-wrap">{value}</span>;
  return <span className="font-mono text-xs break-words">{typeof value === 'number' || typeof value === 'boolean' ? String(value) : formatValue(value, 400)}</span>;
}

function SessionItem({ title, meta, ai, children }: { title: string; meta?: string; ai?: boolean; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {ai ? <Badge variant="secondary">AI</Badge> : null}
        {meta ? <span className="text-muted-foreground text-xs">{meta}</span> : null}
      </div>
      <div className="text-sm">{children}</div>
    </li>
  );
}

function isEntityList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

function SessionView({ view, labelOf, isAiTextStep, recording, hidePhi }: ExecutionContextProps) {
  const items: ReactNode[] = [];
  if (recording) {
    items.push(
      <SessionItem key="audio" title="Audio" meta={recording === 'live' ? 'Live from the microphone' : 'Recording ended'}>
        <span className="text-muted-foreground">Streaming into the run’s sandbox consultation.</span>
      </SessionItem>,
    );
  }
  const { finals, partial } = view.transcript;
  if (finals.length > 0 || partial) {
    items.push(
      <SessionItem key="transcript" title="Transcript" meta={`${finals.length} utterance${finals.length === 1 ? '' : 's'}`}>
        <div className="flex flex-col gap-1">
          {finals.map((line, index) => (
            <p key={`${line.ts}-${index}`}>
              {line.speaker ? <span className="text-muted-foreground mr-1 text-xs">{line.speaker}:</span> : null}
              <Masked value={line.text} hidePhi={hidePhi} plain />
            </p>
          ))}
          {partial ? (
            <p className="text-muted-foreground italic">
              <Masked value={partial.text} hidePhi={hidePhi} plain />
            </p>
          ) : null}
        </div>
      </SessionItem>,
    );
  }
  for (const nodeId of view.nodeOrder) {
    const node = view.nodes[nodeId]!;
    const entities = node.outputs.entities;
    if (isEntityList(entities) && entities.length > 0) {
      items.push(
        <SessionItem key={`entities-${nodeId}`} title="Entities" meta={`from ${labelOf(nodeId)}`}>
          <ul className="flex flex-wrap gap-1.5">
            {entities.map((entity, index) => (
              <li key={index}>
                <Badge variant="outline" className="font-normal">
                  {hidePhi ? PHI_MASK : String(entity.text ?? '?')}
                  {typeof entity.label === 'string' ? <span className="text-muted-foreground ml-1">{entity.label}</span> : null}
                </Badge>
              </li>
            ))}
          </ul>
        </SessionItem>,
      );
    }
    const text = node.outputs.text;
    if (isAiTextStep(nodeId) && typeof text === 'string' && text.length > 0) {
      items.push(
        <SessionItem key={`text-${nodeId}`} title={labelOf(nodeId)} ai meta={node.streaming.includes('text') ? 'writing…' : undefined}>
          <Masked value={text} hidePhi={hidePhi} plain />
        </SessionItem>,
      );
    }
  }
  if (items.length === 0) return <p className="text-muted-foreground text-sm">Session items appear here as the run produces them: audio, transcript, entities and notes.</p>;
  return <ul className="flex flex-col gap-2">{items}</ul>;
}

function ContextView({ view, kinds, sentInput, hidePhi }: ExecutionContextProps) {
  return (
    <div className="flex flex-col gap-3">
      {view.input ? (
        <p className={view.input.valid ? 'text-sm' : 'text-destructive text-sm'}>
          {view.input.valid ? 'The input matches' : 'The input does not match'} {view.input.schema ? `${view.input.schema.slug}${view.input.schema.versionNumber ? ` v${view.input.schema.versionNumber}` : ''}` : 'its schema'}.
          {!view.input.valid && view.input.problems.length > 0 ? ` ${hidePhi ? PHI_MASK : view.input.problems.join('; ')}` : ''}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">{view.status === 'IDLE' ? 'The run input is checked against the Input shape when the run starts.' : 'Not validated yet.'}</p>
      )}
      {kinds.length > 0 ? (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Run input against the Input shape</caption>
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Field
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Type
              </th>
              <th scope="col" className="py-1 font-medium">
                Value sent
              </th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => (
              <tr key={kind.key} className="border-t align-top">
                <td className="py-1.5 pr-3">
                  <code className="font-mono text-xs">{kind.key}</code>
                  {kind.label !== kind.key ? <span className="text-muted-foreground ml-1 text-xs">{kind.label}</span> : null}
                </td>
                <td className="py-1.5 pr-3">
                  <span className="text-xs">{kind.primitive}</span>
                  {kind.phi ? (
                    <Badge variant="outline" className="ml-1 text-[11px]">
                      PHI
                    </Badge>
                  ) : null}
                </td>
                <td className="py-1.5">
                  {sentInput === null ? (
                    <span className="text-muted-foreground text-xs">Not known for a resumed run</span>
                  ) : kind.key in sentInput ? (
                    <Masked value={sentInput[kind.key]} hidePhi={hidePhi} />
                  ) : (
                    <span className="text-muted-foreground text-xs">Not sent</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : sentInput && Object.keys(sentInput).length > 0 ? (
        <pre className="bg-muted rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">{hidePhi ? PHI_MASK : JSON.stringify(sentInput, null, 2)}</pre>
      ) : (
        <p className="text-muted-foreground text-sm">This workflow declares no Input shape.</p>
      )}
    </div>
  );
}

function ConsultationView({ view, labelOf, hidePhi }: ExecutionContextProps) {
  const { fields, consultationId } = view.consultation;
  if (fields.length === 0) {
    return <p className="text-muted-foreground text-sm">No consultation data read yet. A step’s declared reads appear here when it starts.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {consultationId ? (
        <p className="text-muted-foreground text-xs">
          Sandbox consultation <code className="font-mono">{consultationId}</code>
        </p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {fields.map((field) => (
          <li key={`${field.path}-${field.readBy}`} className="flex flex-col gap-0.5 border-t pt-1.5 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{field.path}</code>
              {field.phiClass === 'PHI' ? (
                <Badge variant="outline" className="text-[11px]">
                  PHI
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-xs">
                read by {labelOf(field.readBy)} at {relativeTime(field.ts, view.startedAt) || 'run start'}
              </span>
            </div>
            {'value' in field ? <Masked value={field.value} hidePhi={hidePhi} /> : <span className="text-muted-foreground text-xs">Value not in the trace</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunView_({ view, labelOf, variableStepIds, hidePhi, elapsedMs }: ExecutionContextProps) {
  const variables = variableStepIds.flatMap((nodeId) => Object.entries(view.nodes[nodeId]?.outputs ?? {}).map(([key, value]) => ({ nodeId, key, value })));
  const rows: Array<[string, ReactNode]> = [
    ['Run id', view.runId ? <code className="font-mono text-xs">{view.runId}</code> : '—'],
    ['Status', view.status === 'IDLE' ? 'Not started' : view.status.toLowerCase().replace('_', ' ')],
    ['Workflow', view.slug ? `${view.slug}${view.versionNumber !== undefined ? ` v${view.versionNumber}` : ''}` : '—'],
    ['Elapsed', elapsedMs !== null ? formatDuration(elapsedMs) : '—'],
    ['Tokens', view.tokens ? `${view.tokens.in.toLocaleString('en-US')} in, ${view.tokens.out.toLocaleString('en-US')} out` : '—'],
    ['Steps', `${Object.values(view.nodes).filter((node) => node.status !== 'waiting' && node.status !== 'running').length} finished of ${view.nodeOrder.length} started`],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Variables</h3>
        {variables.length === 0 ? (
          <p className="text-muted-foreground text-xs">{variableStepIds.length === 0 ? 'This workflow declares no variables.' : 'No variable has a value yet.'}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {variables.map((variable) => (
              <li key={`${variable.nodeId}-${variable.key}`} className="flex flex-wrap items-baseline gap-1.5">
                <code className="font-mono text-xs">{variable.key}</code>
                <span className="text-muted-foreground text-xs">({labelOf(variable.nodeId)})</span>
                <span aria-hidden="true">=</span>
                <Masked value={variable.value} hidePhi={hidePhi} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {view.result ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Result</h3>
          {view.result.kind === 'inline' ? (
            <pre className="bg-muted rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">{hidePhi ? PHI_MASK : JSON.stringify(view.result.value, null, 2)}</pre>
          ) : (
            <p className="text-muted-foreground text-xs">Stored by reference ({view.result.sizeBytes.toLocaleString('en-US')} bytes); read it from the run’s result route.</p>
          )}
        </section>
      ) : null}
      {view.error ? (
        <p className="text-destructive text-sm">
          {view.error.code} — {view.error.message}
        </p>
      ) : null}
    </div>
  );
}

export function ExecutionContext(props: ExecutionContextProps) {
  const phiId = useId();
  return (
    <Panel
      title="Execution context"
      actions={
        <div className="flex items-center gap-2">
          <Switch id={phiId} checked={props.hidePhi} onCheckedChange={props.onHidePhiChange} />
          <Label htmlFor={phiId} className="text-xs">
            Hide PHI
          </Label>
        </div>
      }
    >
      <p className="text-muted-foreground text-xs">{props.hidePhi ? 'Patient data is hidden on this screen.' : 'Patient data is shown to admins. Viewing PHI is logged.'}</p>
      <Tabs defaultValue="session" className="gap-3">
        <TabsList variant="line">
          <TabsTrigger value="session">Session</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
          <TabsTrigger value="consultation">Consultation</TabsTrigger>
          <TabsTrigger value="run">Run &amp; variables</TabsTrigger>
        </TabsList>
        <TabsContent value="session">
          <SessionView {...props} />
        </TabsContent>
        <TabsContent value="context">
          <ContextView {...props} />
        </TabsContent>
        <TabsContent value="consultation">
          <ConsultationView {...props} />
        </TabsContent>
        <TabsContent value="run">
          <RunView_ {...props} />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}
