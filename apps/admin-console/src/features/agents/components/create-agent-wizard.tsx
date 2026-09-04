'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AGENT_IO_DEFAULTS } from '@arcaai/workflow-contract';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import {
  AGENT_TASKS,
  AGENT_TASK_LABEL,
  AGENT_TASK_MODEL_TASK_TYPE,
  useCreateAgent,
  useInstructionTemplates,
  usePublishAgent,
  useRegistryModels,
  type Agent,
  type AgentProblemBody,
  type AgentTask,
  type CreateAgentRequest,
  type RegistryModel,
} from '../api';
import { JsonField } from './json-field';
import { ParametersForm } from './parameters-form';

const STEPS = ['Task', 'Model', 'Instruction', 'Parameters', 'Schemas', 'Review'] as const;
type Step = (typeof STEPS)[number];

/** Mirrors CLOUD_BYO_PROVIDERS for the three agent services — a hint, the gateway is the authority. */
const CLOUD_PROVIDERS = new Set(['azure', 'azure-speech', 'bedrock', 'openai', 'anthropic', 'vertex', 'sarvam']);
const ENGINE_PROVIDERS = new Set(['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']);

export function modelAvailabilityHint(model: RegistryModel): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } {
  if (model.resourceStatus !== 'ENABLED') return { label: 'Disabled', variant: 'destructive' };
  const provider = model.provider ?? '';
  if (CLOUD_PROVIDERS.has(provider)) return { label: 'Needs a provider credential', variant: 'secondary' };
  if (ENGINE_PROVIDERS.has(provider)) return { label: 'Engine-served', variant: 'default' };
  if (model.localPath || model.downloadStatus === 'DOWNLOADED') return { label: 'Weights staged', variant: 'default' };
  return { label: 'Weights not staged', variant: 'destructive' };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

interface WizardState {
  task: AgentTask;
  name: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  modelId: string;
  fallbackModelIds: string[];
  instructionMode: 'template' | 'inline';
  promptTemplateId: string;
  systemPrompt: string;
  initialPrompt: string;
  hotwords: string;
  parameters: Record<string, unknown>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

const INITIAL: WizardState = {
  task: 'TEXT_GENERATION',
  name: '',
  slug: '',
  slugTouched: false,
  description: '',
  modelId: '',
  fallbackModelIds: [],
  instructionMode: 'template',
  promptTemplateId: '',
  systemPrompt: '',
  initialPrompt: '',
  hotwords: '',
  parameters: {},
  inputSchema: null,
  outputSchema: null,
};

export function buildCreateRequest(state: WizardState): CreateAgentRequest {
  let instruction: Record<string, unknown> | undefined;
  if (state.task === 'TEXT_GENERATION') {
    instruction = state.instructionMode === 'template' ? { promptTemplateId: state.promptTemplateId } : { systemPrompt: state.systemPrompt };
  } else if (state.task === 'SPEECH_TO_TEXT') {
    const hotwords = state.hotwords
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);
    instruction = { ...(state.initialPrompt ? { initialPrompt: state.initialPrompt } : {}), ...(hotwords.length ? { hotwords } : {}) };
  }
  return {
    slug: state.slug,
    name: state.name.trim(),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    task: state.task,
    modelId: state.modelId,
    ...(state.fallbackModelIds.length ? { fallbackModelIds: state.fallbackModelIds } : {}),
    ...(instruction && Object.keys(instruction).length ? { instruction } : {}),
    ...(Object.keys(state.parameters).length ? { parameters: state.parameters } : {}),
    ...(state.inputSchema ? { inputSchema: state.inputSchema } : {}),
    ...(state.outputSchema ? { outputSchema: state.outputSchema } : {}),
  };
}

function problemToast(error: unknown, fallback: string): void {
  if (error instanceof GatewayError) {
    const body = error.details as AgentProblemBody | undefined;
    const first = body?.findings?.find((finding) => finding.severity === 'ERROR');
    toast.error(first ? `${first.code}: ${first.message}` : error.message);
    return;
  }
  toast.error(fallback);
}

/** The create wizard: Task → Model → Instruction → Parameters → Schemas → Review & publish. */
export function CreateAgentWizard({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (agent: Agent) => void }) {
  const [step, setStep] = useState<Step>('Task');
  const [state, setState] = useState<WizardState>(INITIAL);
  const create = useCreateAgent();
  const publish = usePublishAgent();
  const models = useRegistryModels();
  const templates = useInstructionTemplates();

  const stepIndex = STEPS.indexOf(step);
  const patch = (next: Partial<WizardState>) => setState((current) => ({ ...current, ...next }));

  const taskModels = useMemo(() => (models.data ?? []).filter((model) => model.taskType === AGENT_TASK_MODEL_TASK_TYPE[state.task]), [models.data, state.task]);
  const approvedTemplates = useMemo(() => (templates.data ?? []).filter((template) => template.status === 'APPROVED'), [templates.data]);

  const canAdvance: Record<Step, boolean> = {
    Task: state.name.trim().length > 0 && /^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$/.test(state.slug),
    Model: state.modelId.length > 0,
    Instruction: state.task !== 'TEXT_GENERATION' || (state.instructionMode === 'template' ? state.promptTemplateId.length > 0 : state.systemPrompt.trim().length > 0),
    Parameters: true,
    Schemas: true,
    Review: true,
  };

  async function submit(andPublish: boolean) {
    try {
      const created = await create.mutateAsync(buildCreateRequest(state));
      if (andPublish) {
        try {
          const published = await publish.mutateAsync({ id: created.id, body: { activate: true } });
          toast.success(`Agent ${published.name} published`);
          onCreated(published);
        } catch (error) {
          problemToast(error, 'The draft was created but could not be published.');
          onCreated(created);
        }
      } else {
        toast.success(`Agent ${created.name} created as a draft`);
        onCreated(created);
      }
      setState(INITIAL);
      setStep('Task');
    } catch (error) {
      problemToast(error, 'Could not create the agent.');
    }
  }

  const busy = create.isPending || publish.isPending;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setState(INITIAL);
          setStep('Task');
        }
        onOpenChange(next);
      }}
      size="lg"
      title="New agent"
      meta={
        <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Steps">
          {STEPS.map((name, index) => (
            <li key={name} aria-current={name === step ? 'step' : undefined} className={name === step ? 'font-medium' : index < stepIndex ? '' : 'text-muted-foreground'}>
              {index + 1}. {name}
            </li>
          ))}
        </ol>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button type="button" variant="outline" disabled={stepIndex === 0 || busy} onClick={() => setStep(STEPS[stepIndex - 1])}>
            Back
          </Button>
          {step !== 'Review' ? (
            <Button type="button" disabled={!canAdvance[step] || busy} onClick={() => setStep(STEPS[stepIndex + 1])}>
              Next
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(false)}>
                {create.isPending && !publish.isPending ? <Spinner /> : null}
                Create draft
              </Button>
              <Button type="button" disabled={busy} onClick={() => void submit(true)}>
                {publish.isPending ? <Spinner /> : null}
                Create &amp; publish
              </Button>
            </div>
          )}
        </div>
      }
    >
      {step === 'Task' ? (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              Task <span aria-hidden>*</span>
            </legend>
            <RadioGroup value={state.task} onValueChange={(task) => patch({ task: task as AgentTask, modelId: '', fallbackModelIds: [], parameters: {}, inputSchema: null, outputSchema: null })}>
              {AGENT_TASKS.map((task) => (
                <div key={task} className="flex items-center gap-2">
                  <RadioGroupItem id={`task-${task}`} value={task} />
                  <Label htmlFor={`task-${task}`}>{AGENT_TASK_LABEL[task]}</Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-name">
              Name <span aria-hidden>*</span>
            </Label>
            <Input id="agent-name" value={state.name} required onChange={(event) => patch({ name: event.target.value, ...(state.slugTouched ? {} : { slug: slugify(event.target.value) }) })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-slug">
              Slug <span aria-hidden>*</span>
            </Label>
            <Input id="agent-slug" value={state.slug} required className="font-mono" pattern="^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$" onChange={(event) => patch({ slug: event.target.value, slugTouched: true })} />
            <p className="text-muted-foreground text-xs">Lineage key: 2–80 lowercase alphanumerics, `-` or `_`. Every version of this agent shares it.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea id="agent-description" rows={3} value={state.description} onChange={(event) => patch({ description: event.target.value })} />
          </div>
        </div>
      ) : null}

      {step === 'Model' ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">Registry models whose task type is {AGENT_TASK_MODEL_TASK_TYPE[state.task]}. Publish fails closed when the model is unavailable.</p>
          {models.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <RadioGroup value={state.modelId} onValueChange={(modelId) => patch({ modelId, fallbackModelIds: state.fallbackModelIds.filter((id) => id !== modelId) })} aria-label="Model">
              {taskModels.map((model) => {
                const hint = modelAvailabilityHint(model);
                return (
                  <div key={model.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <RadioGroupItem id={`model-${model.id}`} value={model.id} />
                    <Label htmlFor={`model-${model.id}`} className="flex flex-1 flex-col">
                      <span>{model.name}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {model.slug}
                        {model.provider ? ` · ${model.provider}` : ''}
                      </span>
                    </Label>
                    <Badge variant={hint.variant}>{hint.label}</Badge>
                  </div>
                );
              })}
              {taskModels.length === 0 ? <p className="text-muted-foreground text-sm">No registry model of this task type is visible to this tenant.</p> : null}
            </RadioGroup>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-fallbacks">Fallback models (in order)</Label>
            <Select
              value=""
              onValueChange={(modelId) => patch({ fallbackModelIds: state.fallbackModelIds.includes(modelId) ? state.fallbackModelIds : [...state.fallbackModelIds, modelId] })}
            >
              <SelectTrigger id="agent-fallbacks">
                <SelectValue placeholder="Add a fallback" />
              </SelectTrigger>
              <SelectContent>
                {taskModels
                  .filter((model) => model.id !== state.modelId && !state.fallbackModelIds.includes(model.id))
                  .map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {state.fallbackModelIds.length ? (
              <ol className="flex flex-wrap gap-2">
                {state.fallbackModelIds.map((id, index) => {
                  const model = taskModels.find((candidate) => candidate.id === id);
                  return (
                    <li key={id}>
                      <Button type="button" size="sm" variant="outline" aria-label={`Remove fallback ${model?.name ?? id}`} onClick={() => patch({ fallbackModelIds: state.fallbackModelIds.filter((other) => other !== id) })}>
                        {index + 1}. {model?.name ?? id} ×
                      </Button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 'Instruction' ? (
        <div className="flex flex-col gap-4">
          {state.task === 'TEXT_GENERATION' ? (
            <>
              <RadioGroup value={state.instructionMode} onValueChange={(mode) => patch({ instructionMode: mode as WizardState['instructionMode'] })} aria-label="Instruction source">
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="instr-template" value="template" />
                  <Label htmlFor="instr-template">Approved prompt template (versioned, governed)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="instr-inline" value="inline" />
                  <Label htmlFor="instr-inline">Inline system prompt</Label>
                </div>
              </RadioGroup>
              {state.instructionMode === 'template' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="agent-template">
                    Template <span aria-hidden>*</span>
                  </Label>
                  <Select value={state.promptTemplateId} onValueChange={(promptTemplateId) => patch({ promptTemplateId })}>
                    <SelectTrigger id="agent-template">
                      <SelectValue placeholder={templates.isPending ? 'Loading…' : 'Pick an APPROVED template'} />
                    </SelectTrigger>
                    <SelectContent>
                      {approvedTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">Only APPROVED templates are bindable; the approved version is pinned at publish.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="agent-system-prompt">
                    System prompt <span aria-hidden>*</span>
                  </Label>
                  <Textarea id="agent-system-prompt" rows={8} value={state.systemPrompt} maxLength={50000} onChange={(event) => patch({ systemPrompt: event.target.value })} />
                </div>
              )}
            </>
          ) : state.task === 'SPEECH_TO_TEXT' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-initial-prompt">Initial prompt</Label>
                <Textarea id="agent-initial-prompt" rows={3} maxLength={1000} value={state.initialPrompt} onChange={(event) => patch({ initialPrompt: event.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-hotwords">Hotwords</Label>
                <Input id="agent-hotwords" placeholder="comma-separated" value={state.hotwords} onChange={(event) => patch({ hotwords: event.target.value })} />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">A text-to-speech agent carries no instruction — the voice is a parameter on the next step.</p>
          )}
        </div>
      ) : null}

      {step === 'Parameters' ? <ParametersForm task={state.task} value={state.parameters} onChange={(parameters) => patch({ parameters })} /> : null}

      {step === 'Schemas' ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">Leave a schema empty to use the task default shown as placeholder.</p>
          <JsonField label="Input schema" value={state.inputSchema} onChange={(inputSchema) => patch({ inputSchema })} placeholder={JSON.stringify(AGENT_IO_DEFAULTS[state.task].inputSchema, null, 2)} />
          <JsonField label="Output schema" value={state.outputSchema} onChange={(outputSchema) => patch({ outputSchema })} placeholder={JSON.stringify(AGENT_IO_DEFAULTS[state.task].outputSchema, null, 2)} />
        </div>
      ) : null}

      {step === 'Review' ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Task</dt>
          <dd>{AGENT_TASK_LABEL[state.task]}</dd>
          <dt className="text-muted-foreground">Name</dt>
          <dd>{state.name}</dd>
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="font-mono">{state.slug}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono">{taskModels.find((model) => model.id === state.modelId)?.slug ?? state.modelId}</dd>
          <dt className="text-muted-foreground">Fallbacks</dt>
          <dd className="font-mono">{state.fallbackModelIds.map((id) => taskModels.find((model) => model.id === id)?.slug ?? id).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">Instruction</dt>
          <dd>
            {state.task === 'TEXT_GENERATION'
              ? state.instructionMode === 'template'
                ? (approvedTemplates.find((template) => template.id === state.promptTemplateId)?.name ?? state.promptTemplateId)
                : `${state.systemPrompt.slice(0, 80)}${state.systemPrompt.length > 80 ? '…' : ''}`
              : state.task === 'SPEECH_TO_TEXT'
                ? state.initialPrompt || state.hotwords
                  ? 'Initial prompt / hotwords'
                  : '—'
                : 'None'}
          </dd>
          <dt className="text-muted-foreground">Parameters</dt>
          <dd className="font-mono text-xs">{Object.keys(state.parameters).length ? JSON.stringify(state.parameters) : 'defaults'}</dd>
          <dt className="text-muted-foreground">Schemas</dt>
          <dd>{state.inputSchema || state.outputSchema ? 'custom' : 'task defaults'}</dd>
        </dl>
      ) : null}
    </DetailDrawer>
  );
}
