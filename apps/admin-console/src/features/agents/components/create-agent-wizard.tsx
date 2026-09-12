'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AGENT_IO_DEFAULTS } from '@arcaai/workflow-contract';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useContextSchemaOptions } from '@/shared/catalog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { usePromptTemplateQuickView } from '@/shared/prompt-picker';
import {
  AGENT_TASKS,
  AGENT_TASK_LABEL,
  useCreateAgent,
  usePublishAgent,
  type Agent,
  type AgentProblemBody,
  type AgentTask,
  type CreateAgentRequest,
} from '../api';
import { InstructionBindingForm, instructionFromBinding, instructionToBinding, type InstructionBindingValue } from './instruction-binding-form';
import { JsonField } from './json-field';
import { ModelPicker, fallbackModelOptionLabel, useTaskModelCatalogue } from './model-picker';
import { ParametersForm } from './parameters-form';

const STEPS = ['Task', 'Model', 'Instruction', 'Parameters', 'Schemas', 'Review'] as const;
type Step = (typeof STEPS)[number];

/** No instruction authored yet — defaults to template mode with nothing chosen. */
const NO_INSTRUCTION: InstructionBindingValue = instructionToBinding(null, null, null);

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
  binding: InstructionBindingValue;
  initialPrompt: string;
  hotwords: string;
  /** TASK-930 — the NER label set, comma-separated in the field and split on submit (same shape as `hotwords`). */
  labels: string;
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
  binding: NO_INSTRUCTION,
  initialPrompt: '',
  hotwords: '',
  labels: '',
  parameters: {},
  inputSchema: null,
  outputSchema: null,
};

export function buildCreateRequest(state: WizardState): CreateAgentRequest {
  let instruction: Record<string, unknown> | undefined;
  if (state.task === 'TEXT_GENERATION') {
    instruction = instructionFromBinding(state.binding);
  } else if (state.task === 'SPEECH_TO_TEXT') {
    const hotwords = state.hotwords
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);
    instruction = { ...(state.initialPrompt ? { initialPrompt: state.initialPrompt } : {}), ...(hotwords.length ? { hotwords } : {}) };
  } else if (state.task === 'NAMED_ENTITY_RECOGNITION') {
    // TASK-930 — a NER agent's instruction is its LABEL SET and nothing else. Omitted entirely
    // when empty: a fixed-label checkpoint (`medical-ner`) carries its own taxonomy, so an
    // empty `labels: []` would be a declaration the author did not make.
    const labels = state.labels
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    instruction = labels.length ? { labels } : undefined;
  }
  return {
    slug: state.slug,
    name: state.name.trim(),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    task: state.task,
    modelId: state.modelId,
    ...(state.task === 'TEXT_GENERATION' && state.binding.contextSchemaId
      ? { contextSchemaId: state.binding.contextSchemaId, contextSchemaVersionNumber: state.binding.contextSchemaVersionNumber }
      : {}),
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
export function CreateAgentWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent) => void;
}) {
  const [step, setStep] = useState<Step>('Task');
  const [state, setState] = useState<WizardState>(INITIAL);
  const create = useCreateAgent();
  const publish = usePublishAgent();
  const catalogue = useTaskModelCatalogue(state.task);
  // The Review step names the bound prompt by NAME, not by id: a UUID tells the author nothing
  // about what they are about to publish. `enabled` is the id itself, so nothing is fetched
  // until one is chosen (and the picker has usually warmed this query already).
  const boundTemplate = usePromptTemplateQuickView(state.binding.mode === 'template' ? state.binding.promptTemplateId : null);
  // Same reasoning for the context schema: the Review step is the last thing an author reads
  // before publishing, and a UUID there says nothing about what they are agreeing to. The
  // catalogue is already loaded for the Instruction step's picker, so this costs no extra read.
  const contextSchemas = useContextSchemaOptions();

  const stepIndex = STEPS.indexOf(step);
  const patch = (next: Partial<WizardState>) => setState((current) => ({ ...current, ...next }));

  const fallbackCandidates = useMemo(
    () => catalogue.models.filter((model) => model.id !== state.modelId && !state.fallbackModelIds.includes(model.id)),
    [catalogue.models, state.modelId, state.fallbackModelIds],
  );

  const canAdvance: Record<Step, boolean> = {
    Task: state.name.trim().length > 0 && /^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$/.test(state.slug),
    Model: state.modelId.length > 0,
    Instruction:
      state.task !== 'TEXT_GENERATION' ||
      (state.binding.mode === 'template'
        ? !!state.binding.promptTemplateId
        : state.binding.mode === 'inline'
          ? state.binding.systemPrompt.trim().length > 0
          : state.binding.fragments.length > 0),
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
            <li
              key={name}
              aria-current={name === step ? 'step' : undefined}
              className={name === step ? 'font-medium' : index < stepIndex ? '' : 'text-muted-foreground'}
            >
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
            <RadioGroup
              value={state.task}
              onValueChange={(task) =>
                patch({
                  task: task as AgentTask,
                  modelId: '',
                  fallbackModelIds: [],
                  binding: NO_INSTRUCTION,
                  parameters: {},
                  inputSchema: null,
                  outputSchema: null,
                })
              }
            >
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
            <Input
              id="agent-name"
              value={state.name}
              required
              onChange={(event) => patch({ name: event.target.value, ...(state.slugTouched ? {} : { slug: slugify(event.target.value) }) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-slug">
              Slug <span aria-hidden>*</span>
            </Label>
            <Input
              id="agent-slug"
              value={state.slug}
              required
              className="font-mono"
              pattern="^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$"
              onChange={(event) => patch({ slug: event.target.value, slugTouched: true })}
            />
            <p className="text-muted-foreground text-xs">
              Lineage key: 2–80 lowercase alphanumerics, `-` or `_`. Every version of this agent shares it.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea id="agent-description" rows={3} value={state.description} onChange={(event) => patch({ description: event.target.value })} />
          </div>
        </div>
      ) : null}

      {step === 'Model' ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            Pick a provider, then a model of this task. Publish fails closed when the model is unusable.
          </p>
          <ModelPicker
            task={state.task}
            value={state.modelId}
            onChange={(modelId) => patch({ modelId, fallbackModelIds: state.fallbackModelIds.filter((id) => id !== modelId) })}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-fallbacks">Fallback models (in order)</Label>
            <Select
              value=""
              onValueChange={(modelId) =>
                patch({ fallbackModelIds: state.fallbackModelIds.includes(modelId) ? state.fallbackModelIds : [...state.fallbackModelIds, modelId] })
              }
            >
              <SelectTrigger id="agent-fallbacks">
                <SelectValue placeholder="Add a fallback" />
              </SelectTrigger>
              <SelectContent>
                {/*
                  TASK-958 D-10 — the CONNECTION, not just the model name. Two
                  accounts of one vendor declaring the same wire model produce
                  two rows called "GPT-5.4 mini"; which key each spends is the
                  only thing that differs, and it is the point of a fallback.
                */}
                {fallbackCandidates.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {fallbackModelOptionLabel(model, catalogue.providers)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.fallbackModelIds.length ? (
              <ol className="flex flex-wrap gap-2">
                {state.fallbackModelIds.map((id, index) => {
                  const model = catalogue.models.find((candidate) => candidate.id === id);
                  return (
                    <li key={id}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Remove fallback ${model?.name ?? id}`}
                        onClick={() => patch({ fallbackModelIds: state.fallbackModelIds.filter((other) => other !== id) })}
                      >
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
            <InstructionBindingForm value={state.binding} onChange={(binding) => patch({ binding })} />
          ) : state.task === 'SPEECH_TO_TEXT' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-initial-prompt">Initial prompt</Label>
                <Textarea
                  id="agent-initial-prompt"
                  rows={3}
                  maxLength={1000}
                  value={state.initialPrompt}
                  onChange={(event) => patch({ initialPrompt: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-hotwords">Hotwords</Label>
                <Input
                  id="agent-hotwords"
                  placeholder="comma-separated"
                  value={state.hotwords}
                  onChange={(event) => patch({ hotwords: event.target.value })}
                />
              </div>
            </>
          ) : state.task === 'NAMED_ENTITY_RECOGNITION' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-labels">Entity labels</Label>
              <Input id="agent-labels" placeholder="comma-separated" value={state.labels} onChange={(event) => patch({ labels: event.target.value })} />
              <p className="text-muted-foreground text-xs">
                What to extract. Honoured by zero-shot extractors; a fixed-label checkpoint emits its own set and ignores this.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              A text-to-speech agent carries no instruction — the voice is a parameter on the next step.
            </p>
          )}
        </div>
      ) : null}

      {step === 'Parameters' ? (
        <ParametersForm task={state.task} value={state.parameters} onChange={(parameters) => patch({ parameters })} modelId={state.modelId} />
      ) : null}

      {step === 'Schemas' ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">Leave a schema empty to use the task default shown as placeholder.</p>
          <JsonField
            label="Input schema"
            value={state.inputSchema}
            onChange={(inputSchema) => patch({ inputSchema })}
            placeholder={JSON.stringify(AGENT_IO_DEFAULTS[state.task].inputSchema, null, 2)}
          />
          <JsonField
            label="Output schema"
            value={state.outputSchema}
            onChange={(outputSchema) => patch({ outputSchema })}
            placeholder={JSON.stringify(AGENT_IO_DEFAULTS[state.task].outputSchema, null, 2)}
          />
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
          <dd className="font-mono">{catalogue.models.find((model) => model.id === state.modelId)?.slug ?? state.modelId}</dd>
          <dt className="text-muted-foreground">Fallbacks</dt>
          <dd className="font-mono">
            {state.fallbackModelIds.map((id) => catalogue.models.find((model) => model.id === id)?.slug ?? id).join(', ') || '—'}
          </dd>
          <dt className="text-muted-foreground">Instruction</dt>
          <dd>
            {state.task === 'TEXT_GENERATION'
              ? state.binding.mode === 'template'
                ? (boundTemplate.data?.name ?? state.binding.promptTemplateId ?? '—')
                : state.binding.mode === 'inline'
                  ? `${state.binding.systemPrompt.slice(0, 80)}${state.binding.systemPrompt.length > 80 ? '…' : ''}`
                  : `${state.binding.fragments.length} fragment(s): ${state.binding.fragments.map((fragment) => fragment.key || '(no key)').join(', ')}`
              : state.task === 'SPEECH_TO_TEXT'
                ? state.initialPrompt || state.hotwords
                  ? 'Initial prompt / hotwords'
                  : '—'
                : state.task === 'NAMED_ENTITY_RECOGNITION'
                  ? state.labels || '— (the checkpoint’s own labels)'
                  : 'None'}
          </dd>
          <dt className="text-muted-foreground">Context schema</dt>
          <dd>
            {state.task === 'TEXT_GENERATION' && state.binding.contextSchemaId
              ? (contextSchemas.options.find((option) => option.value === state.binding.contextSchemaId)?.label ?? state.binding.contextSchemaId)
              : '—'}
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
