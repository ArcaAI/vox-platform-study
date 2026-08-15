'use client';

import { IconAlertTriangle, IconChevronDown, IconPlayerStop, IconPlugConnected, IconRefresh, IconSparkles } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { CopyButton } from '@/shared/copy-button';
import { formatNumber } from '@/shared/format';
import type { TaskStreamState } from '../api/use-task-stream';
import type { AssembledDebugMeta, GenerateTextResponse, TextTask, TextTokenUsage } from '../api/types';

/** What the output pane is currently showing (screen-owned). */
export type RunState =
  | { kind: 'idle' }
  | { kind: 'sync'; result: GenerateTextResponse; debug?: AssembledDebugMeta }
  | { kind: 'stream'; taskId: string }
  | { kind: 'fail-closed'; message: string };

interface OutputPaneProps {
  run: RunState;
  stream: TaskStreamState;
  /** Generate POST in flight (sync ack not yet received). */
  isPending: boolean;
  /** Post-mortem GET /text/tasks/:taskId after a transport drop. */
  postMortem: TextTask | undefined;
  /** Effective provider/model for the in-flight stream request (streams never echo it back). */
  streamProviderModel: string;
  onCancel: () => void;
  cancelPending: boolean;
  onRetry: () => void;
  onReattach: () => void;
}

function streamStatusChip(status: TaskStreamState['status']) {
  switch (status) {
    case 'connecting':
    case 'streaming':
      return <StatusBadge label="Task running" colorRole="ai" />;
    case 'done':
      return <StatusBadge label="Done" colorRole="success" />;
    case 'failed':
      return <StatusBadge label="Failed" colorRole="destructive" />;
    case 'error':
      return <StatusBadge label="Dropped" colorRole="warning" />;
    case 'closed':
      return <StatusBadge label="Cancelled" colorRole="neutral" />;
    default:
      return null;
  }
}

function ResultSummary({
  usage,
  latencyMs,
  finishReason,
  providerModel,
}: {
  usage?: TextTokenUsage | null;
  /** undefined: not shown on a stream (text-generation stream frames carry no latency). */
  latencyMs?: number;
  finishReason?: string | null;
  providerModel?: string;
}) {
  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3 text-xs">
      {usage ? (
        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Usage</dt>
          <dd className="font-mono">{`${usage.prompt_tokens} prompt · ${usage.completion_tokens} completion · ${usage.total_tokens} total`}</dd>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">Latency</dt>
        <dd className="font-mono">{latencyMs !== undefined ? `${formatNumber(latencyMs)} ms` : 'n/a'}</dd>
      </div>
      {finishReason ? (
        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Finish reason</dt>
          <dd className="font-mono">{finishReason}</dd>
        </div>
      ) : null}
      {providerModel ? (
        <div className="ml-auto flex items-center gap-1.5">
          <dd className="font-mono">{providerModel}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Admin-only `_debug` assembly meta (debug: true on /text/generate/assembled). */
function AssemblyMetaPanel({ debug }: { debug: AssembledDebugMeta }) {
  const rows: Array<[string, string | undefined]> = [
    ['Type', debug.type],
    ['Visit type', debug.visit_type],
    ['Template', debug.prompt_template_name],
    ['Template ID', debug.prompt_template_id],
    ['DNA style ID', debug.dna_writing_style_id],
    ['Context items', debug.context_item_ids?.join(', ')],
    ['Prompt length', String(debug.prompt_length)],
    ['System prompt length', String(debug.system_prompt_length)],
  ];
  return (
    <Collapsible defaultOpen className="border-t pt-1">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 rounded-md py-2 text-xs font-medium outline-none focus-visible:ring-[3px]">
        Assembly meta
        <IconChevronDown aria-hidden className="size-3.5" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-2">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows
            .filter(([, value]) => value !== undefined && value !== '')
            .map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="font-mono text-xs">{value}</dd>
              </div>
            ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StreamCaret({ live }: { live: boolean }) {
  return live ? (
    <span aria-hidden className="text-primary animate-pulse">
      ▍
    </span>
  ) : null;
}

/** Live/finished reasoning trace, collapsed panel with the same chrome as AssemblyMetaPanel. */
function ReasoningPanel({ reasoning, live }: { reasoning: string; live: boolean }) {
  return (
    <Collapsible defaultOpen className="bg-muted/40 rounded-lg">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium outline-none focus-visible:ring-[3px]">
        Reasoning
        <IconChevronDown aria-hidden className="size-3.5" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
          {reasoning}
          <StreamCaret live={live} />
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Designed 422 error variant: the service failed CLOSED, no toast, a real panel. */
function FailClosedPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="bg-destructive/5 flex flex-col gap-2 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
        <p className="text-destructive text-sm font-semibold">422, text-generation fail-closed</p>
      </div>
      <p className="text-sm font-medium">No model resolved for this tenant.</p>
      <p className="text-muted-foreground text-sm">{message}</p>
      <p className="text-muted-foreground text-xs">
        Provider and model were omitted and the tenant’s HarnessPolicy cascade produced no effective model, the service refuses to guess. Pick an explicit
        provider/model or fix the tenant policy.
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <IconRefresh aria-hidden />
          Retry
        </Button>
      </div>
    </div>
  );
}

function ResponseText({ content, live, onCopy }: { content: string | null | undefined; live: boolean; onCopy?: string | null }) {
  return (
    <div className="group bg-muted/40 relative min-h-32 rounded-lg">
      {onCopy ? (
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton value={onCopy} label="Copy response" />
        </div>
      ) : null}
      <p className="p-4 text-sm leading-relaxed whitespace-pre-wrap">
        {content}
        <StreamCaret live={live} />
      </p>
    </div>
  );
}

export function OutputPane({
  run,
  stream,
  isPending,
  postMortem,
  streamProviderModel,
  onCancel,
  cancelPending,
  onRetry,
  onReattach,
}: OutputPaneProps) {
  const isStreamRun = run.kind === 'stream';
  const streamLive = isStreamRun && (stream.status === 'connecting' || stream.status === 'streaming');
  // Recovery variant: the transport dropped but the task COMPLETED upstream,
  // the post-mortem read supersedes the drop alert and reattach affordance.
  const recovered = isStreamRun && stream.status === 'error' && postMortem?.status === 'completed' ? postMortem : undefined;
  const isActive = isPending || run.kind !== 'idle';

  return (
    <Card className={isActive ? 'border-primary/20 gap-4 shadow-sm' : 'gap-4 shadow-sm'}>
      <CardHeader>
        <CardTitle>Response</CardTitle>
        <CardDescription>
          {isStreamRun
            ? streamLive
              ? 'Streaming via SSE, same-origin through the BFF proxy'
              : 'Streamed via SSE, same-origin through the BFF proxy'
            : 'Runs under your own account'}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <div role="status" className="flex items-center gap-1.5">
              {isStreamRun ? recovered ? <StatusBadge label="Done" colorRole="success" /> : streamStatusChip(stream.status) : null}
              {run.kind === 'sync' ? <StatusBadge label="Done" colorRole="success" /> : null}
              {run.kind === 'sync' && run.debug ? <StatusBadge label="Debug" colorRole="ai" /> : null}
              {isStreamRun && stream.chunkCount > 0 ? <StatusBadge label={`${stream.chunkCount} tokens`} colorRole="neutral" /> : null}
            </div>
            {streamLive ? (
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={cancelPending}>
                <IconPlayerStop aria-hidden />
                Cancel
              </Button>
            ) : null}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isPending ? (
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : run.kind === 'idle' ? (
          <EmptyOutput />
        ) : run.kind === 'fail-closed' ? (
          <FailClosedPanel message={run.message} onRetry={onRetry} />
        ) : run.kind === 'sync' ? (
          <>
            {run.result.reasoning ? <ReasoningPanel reasoning={run.result.reasoning} live={false} /> : null}
            <ResponseText content={run.result.content} live={false} onCopy={run.result.content} />
            <ResultSummary
              usage={run.result.usage}
              latencyMs={run.result.latency_ms}
              finishReason={run.result.finish_reason}
              providerModel={`${run.result.provider} · ${run.result.model}`}
            />
            {run.debug ? <AssemblyMetaPanel debug={run.debug} /> : null}
          </>
        ) : (
          <>
            {stream.reasoning ? <ReasoningPanel reasoning={stream.reasoning} live={streamLive} /> : null}
            <ResponseText
              content={recovered ? recovered.content : stream.content}
              live={streamLive}
              onCopy={streamLive ? undefined : recovered ? recovered.content : stream.content}
            />
            {stream.status === 'failed' ? (
              <div role="alert" className="bg-destructive/10 rounded-lg p-3 text-sm">
                <p className="text-destructive">{`Upstream failure: ${stream.error ?? 'unknown error'}`}</p>
              </div>
            ) : null}
            {recovered ? (
              <>
                <ResultSummary
                  usage={recovered.usage}
                  finishReason={stream.finishReason}
                  providerModel={`${recovered.provider} · ${recovered.model}`}
                />
                <p className="text-muted-foreground text-xs">
                  {`Stream dropped after completion, content recovered via GET /text/tasks/${recovered.task_id}.`}
                </p>
              </>
            ) : null}
            {stream.status === 'error' && !recovered ? (
              <div role="alert" className="border-warning/30 bg-warning/10 flex flex-col gap-2 rounded-lg border p-3 text-sm">
                <p className="font-medium">Stream connection lost.</p>
                <p className="text-muted-foreground">
                  The SSE transport dropped before a terminal frame. Reattaching replays the task’s chunk log from the start, the panel resets
                  automatically.
                </p>
                {postMortem ? (
                  <p className="text-muted-foreground font-mono text-xs">
                    {`Task ${postMortem.status}${postMortem.error ? `: ${postMortem.error}` : ''}`}
                  </p>
                ) : null}
                <div>
                  <Button variant="outline" size="sm" onClick={onReattach}>
                    <IconPlugConnected aria-hidden />
                    Reattach stream
                  </Button>
                </div>
              </div>
            ) : null}
            {stream.status === 'done' || stream.status === 'closed' ? (
              <ResultSummary usage={stream.usage} finishReason={stream.finishReason} providerModel={streamProviderModel} />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyOutput() {
  return (
    <div className="bg-muted/40 flex flex-col items-center justify-center gap-3 rounded-lg p-12 text-center">
      <div className="bg-background flex size-10 items-center justify-center rounded-full shadow-sm">
        <IconSparkles aria-hidden className="text-muted-foreground size-5" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">No output yet</p>
        <p className="text-muted-foreground max-w-xs text-sm">
          Write a prompt and press Run. Streaming is on by default, flip the switch for a single sync response.
        </p>
      </div>
    </div>
  );
}
