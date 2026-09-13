'use client';

/**
 * Frame 54 / artboard 4f — LLM Playground (tier 50–59, matrix row 38).
 *
 * RENAMED from "Agent Playground" by (route unchanged). Nothing
 * agent- or workflow-shaped runs here: the three tabs are raw calls to the text,
 * guardrail and NLP services. Agents and workflows are authored in
 * `/workflow-studio` and exercised in `/playground/workbench` and
 * `/playground/consultation`, so the old name pointed a clinician at the wrong
 * screen for the job.
 *
 * The Text generation tab: prompt + generate via the `text-generations/*` gateway proxy
 * (sync or streaming, assembled mode with the admin-only debug meta,
 * provider/guardrail catalogs with the elevated __GLOBAL__ view; streaming
 * rides a same-origin BFF-proxied EventSource — see use-task-stream.ts). The
 * Guardrails and NER tabs proxy the Guardrail / NLP services through
 * the user-plane `ai/*` gateway routes.
 *
 * Frame: `ScreenTemplate` (rule 11 §1) in `scroll` mode, wrapped in `<Tabs>` so
 * the pinned `tabs` region and the `TabsContent` panels in `children` share one
 * context. The run status moved out of the text panel into the pinned
 * `StatusFooter`; header/tabs stay width-matched to the 1440px work canvas.
 */

import { IconPlayerPlay } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { GuardrailsTab } from './guardrails-tab';
import { NerTab } from './ner-tab';
import { useCancelTask, useGenerateAssembled, useGenerateText, useTextGuardrailProviders, useTextProviders, useTextTask } from '../api/hooks';
import type { AssembledGenerateRequest, AssembledGenerateResponse, GenerateTextRequest } from '../api/types';
import { isStreamingAck } from '../api/types';
import { useTaskStream } from '../api/use-task-stream';
import type { TaskStreamState } from '../api/use-task-stream';
import { OutputPane } from './output-pane';
import type { RunState } from './output-pane';
import { PromptEditorCard } from './prompt-editor-card';
import type { LlmFormState } from './prompt-editor-card';
import { ProvidersCard } from './providers-card';

const INITIAL_FORM: LlmFormState = {
  prompt: '',
  systemPrompt: '',
  temperature: 0.1,
  maxTokens: '65536',
  streaming: true,
  assembled: false,
  assembledType: 'pre-summary',
  visitType: 'new_visit',
  message: '',
  contextItemIds: '',
  templateId: '',
  dnaStyleId: '',
  debug: false,
};

type LlmRequest = { assembled: false; body: GenerateTextRequest } | { assembled: true; body: AssembledGenerateRequest };

function parseMaxTokens(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 1024;
  return Math.min(Math.max(parsed, 1), 32768);
}

function formatSentProviderModel(request: LlmRequest | null): string {
  const provider = request?.body.provider ?? '';
  const model = request?.body.model ?? '';
  return model ? `${provider} \u00b7 ${model}` : provider;
}

/**
 * Frame 54 strip under the header: the EFFECTIVE request settings, including
 * the HarnessPolicy-cascade note whenever provider/model are omitted, plus
 * the live task id. (The cancel control lives on the output pane header.)
 */
function RequestSummaryStrip({
  providersLoading,
  hasCatalog,
  selectedProvider,
  selectedModel,
  temperature,
  maxTokens,
  streaming,
  taskId,
}: {
  providersLoading: boolean;
  hasCatalog: boolean;
  selectedProvider: string;
  selectedModel: string;
  temperature: number;
  maxTokens: number;
  streaming: boolean;
  taskId: string | null;
}) {
  const separator = (
    <span aria-hidden className="text-border">
      {'\u00b7'}
    </span>
  );
  return (
    <div className="bg-card text-foreground flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 font-mono text-xs">
      {providersLoading ? (
        <Skeleton className="h-4 w-48" />
      ) : hasCatalog ? (
        <>
          <span>
            <span className="text-muted-foreground">Provider </span>
            {selectedProvider}
          </span>
          {separator}
          {selectedModel ? (
            <span>
              <span className="text-muted-foreground">model </span>
              {selectedModel}
            </span>
          ) : (
            <span className="text-muted-foreground">model omitted {'\u2192'} tenant default via HarnessPolicy cascade</span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">provider/model omitted {'\u2192'} tenant default via HarnessPolicy cascade</span>
      )}
      {separator}
      <span>
        <span className="text-muted-foreground">temp </span>
        {temperature.toFixed(1)}
      </span>
      {separator}
      <span>
        <span className="text-muted-foreground">max-tokens </span>
        {maxTokens}
      </span>
      {separator}
      <span className={streaming ? 'font-medium' : ''}>{streaming ? 'streaming' : 'sync'}</span>
      {taskId ? (
        <>
          {separator}
          <span>
            <span className="text-muted-foreground">task </span>
            {taskId}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Short footer summary per relayed `error_code` (TASK-969 WS-3) — mirrors the
 * `FailClosedPanel` branches in `output-pane.tsx` without duplicating their copy. */
function failClosedSummary(code: string | undefined): string {
  switch (code) {
    case 'MODEL_NOT_SELECTED':
      return 'no effective model for this tenant';
    case 'CONTENT_BLOCKED_NOT_MEDICAL':
      return 'prompt not classified as clinical content';
    case 'CONTENT_BLOCKED':
      return 'blocked by the safety guardrail';
    default:
      return 'see output panel for details';
  }
}

function footerStatus(run: RunState, stream: TaskStreamState, isPending: boolean, recovered: boolean): string {
  if (isPending) return 'Generating…';
  switch (run.kind) {
    case 'idle':
      return 'Idle — no generation yet';
    case 'fail-closed':
      return `Generation failed closed (422) — ${failClosedSummary(run.code)}`;
    case 'sync':
      return `Run complete — ${run.result.provider} / ${run.result.model}`;
    case 'stream':
      switch (stream.status) {
        case 'connecting':
          return `Connecting to task ${run.taskId}…`;
        case 'streaming':
          return `Streaming task ${run.taskId}…`;
        case 'done':
          return `Run complete — task ${run.taskId}`;
        case 'failed':
          return `Task ${run.taskId} failed upstream`;
        case 'error':
          return recovered
            ? `Run complete — task ${run.taskId} finalized from the post-mortem read`
            : 'Stream dropped — reattach or read the task post-mortem';
        case 'closed':
          return `Run cancelled — task ${run.taskId}`;
        default:
          return 'Preparing stream…';
      }
  }
}

export function PlaygroundLlmScreen() {
  return (
    <WorkingTenantGate
      title="LLM Playground"
      meta={<span>POST /text-generations/generate · SSE /text-generations/tasks/:taskId/stream · providers from the tenant catalog</span>}
      description="Playground generations run inside a tenant’s provider catalog and HarnessPolicy. Pick a working tenant from the switcher in the top bar."
    >
      <PlaygroundLlmBody />
    </WorkingTenantGate>
  );
}

function PlaygroundLlmBody() {
  const session = useSession();
  const roles = session.data?.user.roles ?? [];
  const isElevated = session.data?.isElevated ?? false;
  const workingTenantName = session.data?.workingTenantName ?? null;
  const canDebug = roles.includes('SUPER_ADMIN') || roles.includes('TENANT_ADMIN');

  const [globalCatalog, setGlobalCatalog] = useState(false);
  const tenantKey = globalCatalog ? '__GLOBAL__' : undefined;
  const providersQuery = useTextProviders(tenantKey);
  const guardrailsQuery = useTextGuardrailProviders(tenantKey);

  const [form, setForm] = useState<LlmFormState>(INITIAL_FORM);
  const patch = useCallback((partial: Partial<LlmFormState>) => setForm((previous) => ({ ...previous, ...partial })), []);

  // Provider/model choices cascade: is_default drives the preselection,
  // default_model follows, and a provider change resets the model choice.
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const providers = providersQuery.data;
  const defaultProvider =
    providers?.find((provider) => provider.is_default && provider.is_available) ??
    providers?.find((provider) => provider.is_available) ??
    providers?.[0];
  const selectedProvider = providerChoice ?? defaultProvider?.name ?? '';
  const activeProvider = providers?.find((provider) => provider.name === selectedProvider);
  const selectedModel = modelChoice ?? activeProvider?.default_model ?? activeProvider?.models[0]?.name ?? '';

  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const stream = useTaskStream(run.kind === 'stream' ? run.taskId : null);
  const postMortemQuery = useTextTask(run.kind === 'stream' ? run.taskId : null, stream.status === 'error');
  const recovered = run.kind === 'stream' && stream.status === 'error' && postMortemQuery.data?.status === 'completed';

  const generateMutation = useGenerateText();
  const assembledMutation = useGenerateAssembled();
  const cancelMutation = useCancelTask();
  // State (not a ref): the last request also renders as the stream's
  // provider/model line, so the read must be reactive.
  const [lastRequest, setLastRequest] = useState<LlmRequest | null>(null);
  const isPending = generateMutation.isPending || assembledMutation.isPending;

  const runRequest = (request: LlmRequest) => {
    setLastRequest(request);
    const handleSuccess = (outcome: AssembledGenerateResponse) => {
      if (isStreamingAck(outcome)) setRun({ kind: 'stream', taskId: outcome.task_id });
      else setRun({ kind: 'sync', result: outcome, debug: outcome._debug });
    };
    const handleError = (error: unknown) => {
      if (error instanceof GatewayError && error.status === 422) {
        // TASK-969 WS-3: the gateway relays a closed-vocabulary `error_code`
        // (never the upstream `detail`, which can quote the prompt) inside the
        // parsed body — `GatewayError.details` — alongside its own fixed
        // `detail` phrase. Prefer that phrase for the message line and fall
        // back to `error.message` for a body shaped like a generic Nest error.
        const details = error.details as { detail?: string; error_code?: string } | undefined;
        setRun({ kind: 'fail-closed', message: details?.detail ?? error.message, code: details?.error_code });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Generation failed');
    };
    if (request.assembled) assembledMutation.mutate(request.body, { onSuccess: handleSuccess, onError: handleError });
    else generateMutation.mutate(request.body, { onSuccess: handleSuccess, onError: handleError });
  };

  const contextIds = form.contextItemIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const hasMessage = form.message.trim().length > 0;
  const exactlyOneSource = hasMessage !== contextIds.length > 0;
  const canGenerate = form.assembled ? exactlyOneSource : form.prompt.trim().length > 0;
  const sourceHint =
    form.assembled && !exactlyOneSource
      ? hasMessage
        ? 'Provide exactly one context source — clear the message or the context item IDs.'
        : 'Provide exactly one context source — a message or comma-separated context item IDs.'
      : null;

  const handleGenerate = () => {
    const shared = {
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      temperature: form.temperature,
      max_tokens: parseMaxTokens(form.maxTokens),
      stream: form.streaming,
    };
    if (form.assembled) {
      runRequest({
        assembled: true,
        body: {
          type: form.assembledType,
          visit_type: form.visitType,
          ...(hasMessage ? { message: form.message } : { context_item_ids: contextIds }),
          ...(form.templateId.trim() ? { prompt_template_id: form.templateId.trim() } : {}),
          ...(form.dnaStyleId.trim() ? { dna_writing_style_id: form.dnaStyleId.trim() } : {}),
          ...shared,
          ...(canDebug && form.debug ? { debug: true } : {}),
        },
      });
    } else {
      runRequest({
        assembled: false,
        body: {
          prompt: form.prompt,
          ...(form.systemPrompt ? { system_prompt: form.systemPrompt } : {}),
          ...shared,
        },
      });
    }
  };

  const handleRetry = () => {
    if (lastRequest) runRequest(lastRequest);
  };

  const handleCancel = () => {
    if (run.kind !== 'stream') return;
    cancelMutation.mutate(run.taskId, {
      onSuccess: () => stream.close(),
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Cancel failed'),
    });
  };

  const handleRefreshCatalogs = () => {
    void providersQuery.refetch();
    void guardrailsQuery.refetch();
  };

  return (
    <Tabs defaultValue="text" className="flex min-h-0 flex-1 flex-col">
      <ScreenTemplate
        header={
          <div className="mx-auto w-full max-w-[1440px] px-4">
            <CanvasHeader
              title="LLM Playground"
              description={'Compose → run → stream · runs under your own account'}
              actions={
                <Button onClick={handleGenerate} disabled={isPending || !canGenerate}>
                  <IconPlayerPlay aria-hidden />
                  Run
                </Button>
              }
            />
          </div>
        }
        tabs={
          <div className="mx-auto w-full max-w-[1440px] px-4">
            <TabsList variant="line">
              <TabsTrigger value="text">Text generation</TabsTrigger>
              <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
              <TabsTrigger value="ner">NER</TabsTrigger>
            </TabsList>
          </div>
        }
        footer={
          // The header's Run action is text generation on every tab, so the
          // run state is the page-level status — this replaces the in-tab
          // status line it used to render above the three-pane grid. No `end`
          // meta: provider/model/mode/task id are all carried by
          // `RequestSummaryStrip`, and repeating them here would only
          // double-announce each change through the footer's live region.
          <StatusFooter start={footerStatus(run, stream, isPending, recovered)} />
        }
      >
        <PlaygroundCanvas className="max-w-[1440px]">
          <TabsContent value="text" className="flex flex-col gap-4">
            <RequestSummaryStrip
              providersLoading={providersQuery.isLoading}
              hasCatalog={!!providers && providers.length > 0}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              temperature={form.temperature}
              maxTokens={parseMaxTokens(form.maxTokens)}
              streaming={form.streaming}
              taskId={run.kind === 'stream' ? run.taskId : null}
            />
            <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,3fr)_minmax(0,4fr)_minmax(0,3fr)]">
              <PromptEditorCard
                form={form}
                onPatch={patch}
                providers={providers}
                providersLoading={providersQuery.isLoading}
                selectedProvider={selectedProvider}
                selectedModel={selectedModel}
                onProviderChange={(name) => {
                  setProviderChoice(name);
                  setModelChoice(null);
                }}
                onModelChange={setModelChoice}
                canDebug={canDebug}
                sourceHint={sourceHint}
              />
              <OutputPane
                run={run}
                stream={stream}
                isPending={isPending}
                postMortem={postMortemQuery.data}
                streamProviderModel={formatSentProviderModel(lastRequest)}
                onCancel={handleCancel}
                cancelPending={cancelMutation.isPending}
                onRetry={handleRetry}
                onReattach={stream.reopen}
              />
              <ProvidersCard
                providers={providers}
                providersLoading={providersQuery.isLoading}
                providersError={providersQuery.error}
                guardrails={guardrailsQuery.data}
                guardrailsLoading={guardrailsQuery.isLoading}
                guardrailsError={guardrailsQuery.error}
                onRefresh={handleRefreshCatalogs}
                showGlobalSwitch={isElevated}
                globalCatalog={globalCatalog}
                onGlobalCatalogChange={setGlobalCatalog}
                workingTenantName={workingTenantName}
              />
            </div>
          </TabsContent>

          {/* Guardrails + NER: user-plane `ai/*` gateway proxies over
                    the Guardrail (:8863) and NLP (:8864) services. */}
          <TabsContent value="guardrails">
            <GuardrailsTab />
          </TabsContent>
          <TabsContent value="ner">
            <NerTab />
          </TabsContent>
        </PlaygroundCanvas>
      </ScreenTemplate>
    </Tabs>
  );
}
