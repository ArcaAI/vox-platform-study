'use client';

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AGENT_IO_DEFAULTS, AGENT_TAG_PATTERN } from '@arcaai/workflow-contract';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useContextSchemaOptions } from '@/shared/catalog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { usePromptTemplateQuickView } from '@/shared/prompt-picker';
import { TagsField } from '@/shared/tags-field';
import {
  AGENT_TASKS,
  AGENT_TASK_LABEL,
  ContextSchemaField,
  InstructionBindingForm,
  JsonField,
  ModelPicker,
  fallbackModelOptionLabel,
  getAgent,
  instructionFromBinding,
  instructionToBinding,
  useAgentLineageBySlug,
  useAgentLineageVersions,
  useCreateAgent,
  useNewAgentVersion,
  usePublishAgent,
  useTaskModelCatalogue,
  useUpdateAgent,
  type Agent,
  type AgentFinding,
  type AgentProblemBody,
  type AgentTask,
  type CreateAgentRequest,
  type InstructionBindingValue,
  type UpdateAgentRequest,
} from './agents-feature';
import { documentTemplateSlugOf, withDocumentTemplate } from './instruction-extras';
import { AgentSimpleParameters } from './simple-parameters';

const CREATE_STEPS = ['Task', 'Model', 'Instruction', 'Settings', 'Input / Output contract', 'Review'] as const;
/** Editing a published agent (Studio, OD-12): the lineage, task and contract are fixed; model, prompt and settings change. */
const EDIT_STEPS = ['Model', 'Instruction', 'Settings', 'Review'] as const;
type Step = (typeof CREATE_STEPS)[number];

const TAG_GRAMMAR_HINT = 'Agent tags are key:value — lower-case letters, digits, "-" and "_" (the value also allows "."), e.g. dept:cardiology.';
const validateAgentTag = (tag: string) => (AGENT_TAG_PATTERN.test(tag) ? null : `"${tag}" is not a valid agent tag. ${TAG_GRAMMAR_HINT}`);

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
  /** TASK-1036 OD-7 — `instruction.documentTemplate.slug` (TEXT_GENERATION); always resolves the latest approved version. */
  documentTemplateSlug?: string | null;
  tags?: string[];
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
  documentTemplateSlug: null,
  tags: [],
};

function instructionOf(state: WizardState): Record<string, unknown> | undefined {
  let instruction: Record<string, unknown> | undefined;
  if (state.task === 'TEXT_GENERATION') {
    instruction = withDocumentTemplate(instructionFromBinding(state.binding), state.documentTemplateSlug ?? null);
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
  return instruction && Object.keys(instruction).length ? instruction : undefined;
}

export function buildCreateRequest(state: WizardState): CreateAgentRequest {
  const instruction = instructionOf(state);
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
    ...(instruction ? { instruction } : {}),
    ...(Object.keys(state.parameters).length ? { parameters: state.parameters } : {}),
    ...(state.inputSchema ? { inputSchema: state.inputSchema } : {}),
    ...(state.outputSchema ? { outputSchema: state.outputSchema } : {}),
    ...(state.tags?.length ? { tags: state.tags } : {}),
  };
}

function stringField(instruction: Record<string, unknown> | null, key: string): string {
  const value = instruction?.[key];
  return typeof value === 'string' ? value : '';
}

/** The wizard state an existing agent version edits from — the inverse of `buildEditPatch`. */
export function stateFromAgent(agent: Agent): WizardState {
  const instruction = agent.instruction as Record<string, unknown> | null;
  const hotwords = instruction?.hotwords;
  const labels = instruction?.labels;
  return {
    task: agent.task,
    name: agent.name,
    slug: agent.slug,
    slugTouched: true,
    description: agent.description ?? '',
    modelId: agent.modelId,
    fallbackModelIds: [...agent.fallbacks].sort((a, b) => a.priority - b.priority).map((fallback) => fallback.modelId),
    binding: instructionToBinding(instruction, agent.contextSchemaId, agent.contextSchemaVersionNumber),
    initialPrompt: stringField(instruction, 'initialPrompt'),
    hotwords: Array.isArray(hotwords) ? hotwords.join(', ') : '',
    labels: Array.isArray(labels) ? labels.join(', ') : '',
    parameters: agent.parameters ?? {},
    inputSchema: agent.inputSchema,
    outputSchema: agent.outputSchema,
    documentTemplateSlug: documentTemplateSlugOf(instruction),
    tags: agent.tags,
  };
}

/** The PATCH that brings a draft in line with `state`. Name and description stay with the version being edited. */
export function buildEditPatch(state: WizardState): UpdateAgentRequest {
  const instruction = instructionOf(state);
  return {
    modelId: state.modelId,
    fallbackModelIds: state.fallbackModelIds,
    parameters: state.parameters,
    tags: state.tags ?? [],
    ...(instruction ? { instruction } : {}),
    ...(state.task === 'TEXT_GENERATION' ? { contextSchemaId: state.binding.contextSchemaId, contextSchemaVersionNumber: state.binding.contextSchemaVersionNumber } : {}),
    ...(state.inputSchema ? { inputSchema: state.inputSchema } : {}),
    ...(state.outputSchema ? { outputSchema: state.outputSchema } : {}),
  };
}

/** Key-sorted JSON, so two equal documents compare equal however Postgres ordered their keys. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
}

function findingsOf(error: unknown): AgentFinding[] {
  if (!(error instanceof GatewayError)) return [];
  return ((error.details as AgentProblemBody | undefined)?.findings ?? []).filter((finding) => finding.severity === 'ERROR');
}

function problemToast(error: unknown, fallback: string): void {
  if (error instanceof GatewayError) {
    const first = findingsOf(error)[0];
    toast.error(first ? `${first.code}: ${first.message}` : error.message);
    return;
  }
  toast.error(fallback);
}

/** How a wizard run ended — `published: false` with `findings` is a draft kept for a stated reason. */
export interface AgentWizardResult {
  published: boolean;
  /** True when publish was attempted and refused — the draft stays open to be fixed, as opposed to a draft saved on purpose. */
  blocked: boolean;
  /** The blocking findings that kept the agent DRAFT (publish fails closed; a prompt that is not APPROVED is one). */
  findings: AgentFinding[];
}

export interface AgentWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires at every terminal outcome with the agent row as it now stands. */
  onCreated: (agent: Agent, result?: AgentWizardResult) => void;
  /**
   * Edit instead of create: branch a NEW version off `versionNumber` (default: the active one) of
   * `slug`, change it, and publish it WITHOUT moving the active pointer — so only the caller that
   * re-pins to the new version is affected (TASK-1036 OD-12).
   */
  edit?: { slug: string; versionNumber?: number | null };
}

/**
 * The agent wizard: Task (+ context schema) → Model → Instruction → Settings → Input / Output
 * contract → Review & publish; or, in `edit` mode, Model → Instruction → Settings → Review.
 * The context schema is chosen ONCE, on the first step, because it decides what every later
 * prompt editor completes and lints against.
 *
 * Never approves anything: a prompt that is not APPROVED makes publish fail closed, and the
 * agent stays a DRAFT with the reason shown (TASK-1036 D-7).
 */
export function AgentWizard(props: AgentWizardProps) {
  if (props.edit) return <EditLoader {...props} edit={props.edit} />;
  return <WizardBody {...props} base={null} />;
}

function EditLoader({ open, onOpenChange, onCreated, edit }: AgentWizardProps & { edit: NonNullable<AgentWizardProps['edit']> }) {
  const lineage = useAgentLineageBySlug(edit.slug, { enabled: open });
  const versions = useAgentLineageVersions(lineage.data ?? null);
  const rows = versions.data ?? [];
  const base = rows.find((row) => row.versionNumber === (edit.versionNumber ?? lineage.data?.active?.versionNumber)) ?? null;

  if (!base) {
    const failed = lineage.isError || versions.isError || (!lineage.isPending && !lineage.data) || (!versions.isPending && !versions.isFetching && !base && !!lineage.data);
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="Edit agent">
        {failed ? (
          <p className="text-muted-foreground text-sm">That agent version could not be loaded, so it cannot be edited here.</p>
        ) : (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </DetailDrawer>
    );
  }
  return <WizardBody open={open} onOpenChange={onOpenChange} onCreated={onCreated} base={base} key={base.id} />;
}

function WizardBody({ open, onOpenChange, onCreated, base }: Omit<AgentWizardProps, 'edit'> & { base: Agent | null }) {
  const editing = base !== null;
  const STEPS: readonly Step[] = editing ? (EDIT_STEPS as readonly Step[]) : CREATE_STEPS;
  const [step, setStep] = useState<Step>(STEPS[0]);
  const [state, setState] = useState<WizardState>(() => (base ? stateFromAgent(base) : INITIAL));
  const [outcome, setOutcome] = useState<{ agent: Agent; findings: AgentFinding[] } | null>(null);
  // The draft this run has already written. A publish refused for a stated reason leaves it
  // behind; a retry updates THIS row instead of branching or creating a duplicate.
  const draftRef = useRef<Agent | null>(null);
  const create = useCreateAgent();
  const branch = useNewAgentVersion();
  const update = useUpdateAgent();
  const publish = usePublishAgent();
  const catalogue = useTaskModelCatalogue(state.task);
  // The Review step names the bound prompt by NAME, not by id: a UUID tells the author nothing
  // about what they are about to publish. `enabled` is the id itself, so nothing is fetched
  // until one is chosen (and the picker has usually warmed this query already).
  const boundTemplate = usePromptTemplateQuickView(state.binding.mode === 'template' ? state.binding.promptTemplateId : null);
  // Same reasoning for the context schema: the Review step is the last thing an author reads
  // before publishing, and a UUID there says nothing about what they are agreeing to. The
  // catalogue is already loaded for the Task step's schema picker, so this costs no extra read.
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
    Settings: true,
    'Input / Output contract': true,
    Review: true,
  };

  function reset() {
    setState(base ? stateFromAgent(base) : INITIAL);
    setStep(STEPS[0]);
    setOutcome(null);
    draftRef.current = null;
  }

  /** Writes `state` to the run's draft (creating / branching it first), skipping a no-op PATCH. */
  async function saveDraft(): Promise<Agent> {
    let draft = draftRef.current;
    if (!draft) {
      draft = base ? await branch.mutateAsync({ id: base.id }) : await create.mutateAsync(buildCreateRequest(state));
      draftRef.current = draft;
    }
    const wanted = buildEditPatch(state);
    if (stableKey(wanted) === stableKey(buildEditPatch(stateFromAgent(draft)))) return draft;
    const fresh = await getAgent(draft.id);
    try {
      const saved = await update.mutateAsync({ id: draft.id, patch: wanted, etag: fresh.etag });
      draftRef.current = saved.data;
      return saved.data;
    } catch (error) {
      // "No changes to write" — the server saw the same bytes; the draft is already what we want.
      if (error instanceof GatewayError && error.status === 400 && /no changes/i.test(error.message)) return draft;
      throw error;
    }
  }

  async function submit(andPublish: boolean) {
    setOutcome(null);
    let draft: Agent;
    try {
      draft = await saveDraft();
    } catch (error) {
      problemToast(error, editing ? 'Could not save the new version.' : 'Could not create the agent.');
      return;
    }
    if (!andPublish) {
      toast.success(editing ? `Draft v${draft.versionNumber} saved` : `Agent ${draft.name} created as a draft`);
      onCreated(draft, { published: false, blocked: false, findings: [] });
      reset();
      return;
    }
    try {
      // Editing never moves the active pointer: the caller re-pins to the new version (OD-12).
      const published = await publish.mutateAsync({ id: draft.id, body: { activate: !editing } });
      toast.success(editing ? `Version ${published.versionNumber} of ${published.name} published` : `Agent ${published.name} published`);
      onCreated(published, { published: true, blocked: false, findings: [] });
      reset();
    } catch (error) {
      const findings = findingsOf(error);
      setOutcome({ agent: draft, findings });
      problemToast(error, 'The draft was saved but could not be published.');
      onCreated(draft, { published: false, blocked: true, findings });
    }
  }

  const busy = create.isPending || branch.isPending || update.isPending || publish.isPending;
  const title = editing ? `Edit agent — ${base.name}` : 'New agent';

  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      size="lg"
      title={title}
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
                {busy && !publish.isPending ? <Spinner /> : null}
                {editing ? 'Save draft' : 'Create draft'}
              </Button>
              <Button type="button" disabled={busy} onClick={() => void submit(true)}>
                {publish.isPending ? <Spinner /> : null}
                {editing ? 'Publish new version' : 'Create & publish'}
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
          {state.task === 'TEXT_GENERATION' ? (
            <ContextSchemaField
              idPrefix="agent"
              value={state.binding}
              onChange={(next) => patch({ binding: { ...state.binding, ...next } })}
              options={contextSchemas.options}
              isLoading={contextSchemas.isLoading}
            />
          ) : null}
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
            <InstructionBindingForm simple value={state.binding} onChange={(binding) => patch({ binding })} hideContextSchema={!editing} />
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

      {step === 'Settings' ? (
        <div className="flex flex-col gap-6">
          <AgentSimpleParameters
            task={state.task}
            modelId={state.modelId}
            value={state.parameters}
            onChange={(parameters) => patch({ parameters })}
            documentTemplateSlug={state.documentTemplateSlug ?? null}
            onDocumentTemplateChange={(documentTemplateSlug) => patch({ documentTemplateSlug })}
          />
          <TagsField
            id="agent-tags"
            value={state.tags ?? []}
            onChange={(tags) => patch({ tags })}
            suggestionsPath="admin/agents/tags"
            validate={validateAgentTag}
            description={TAG_GRAMMAR_HINT}
          />
        </div>
      ) : null}

      {step === 'Input / Output contract' ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            The JSON shape this agent accepts and returns. Leave either empty to use the task default shown as placeholder.
          </p>
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
          {state.task === 'TEXT_GENERATION' ? (
            <>
              <dt className="text-muted-foreground">Document template</dt>
              <dd>{state.documentTemplateSlug ? `${state.documentTemplateSlug} (latest approved)` : 'Platform layout'}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Settings</dt>
          <dd className="font-mono text-xs">{Object.keys(state.parameters).length ? JSON.stringify(state.parameters) : 'defaults'}</dd>
          <dt className="text-muted-foreground">Tags</dt>
          <dd className="font-mono text-xs">{state.tags?.length ? state.tags.join(', ') : '—'}</dd>
          <dt className="text-muted-foreground">Input / Output contract</dt>
          <dd>{state.inputSchema || state.outputSchema ? 'custom' : 'task defaults'}</dd>
        </dl>
      ) : null}
      {step === 'Review' && editing ? (
        <p className="text-muted-foreground mt-4 text-sm">
          Publishing creates a new version of {state.slug}. The active version does not change; only the step that opened this editor moves to the new version.
        </p>
      ) : null}
      {step === 'Review' && outcome ? (
        <Alert variant="destructive" className="mt-4" role="alert">
          <AlertTitle>Kept as draft v{outcome.agent.versionNumber} — not published</AlertTitle>
          <AlertDescription>
            {outcome.findings.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {outcome.findings.map((finding, index) => (
                  <li key={`${finding.code}-${index}`}>
                    <span className="font-mono">{finding.code}</span> — {finding.message}
                  </li>
                ))}
              </ul>
            ) : (
              'The gateway refused to publish this draft.'
            )}
            <span className="mt-2 block">Fix the cause (for example, approve the prompt on Hope Prompts) and publish again. Nothing was approved for you.</span>
          </AlertDescription>
        </Alert>
      ) : null}
    </DetailDrawer>
  );
}
