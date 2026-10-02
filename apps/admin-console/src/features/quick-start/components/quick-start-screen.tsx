'use client';

/**
 * Quick start (tier 30-49) — one page from a context schema to a workflow that governs a
 * department: choose a preset or an existing schema → name the agent and its model + prompt →
 * name the workflow → pick where it applies. "Create and assign" then drives the existing admin
 * endpoints in order (`lib/quick-start-plan.ts`), with a progress line per step that links out to
 * the full editor for the row it made. The full editors stay the place for anything advanced.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { IconCheck, IconCircleDashed, IconExternalLink, IconHourglass, IconX } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useContextSchemaDefinition, useContextSchemaOptions, useDepartmentOptions, useModelCatalogue } from '@/shared/catalog';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { PromptTemplatePicker } from '@/shared/prompt-picker';
import { TemplateField, contextVariablePaths, declaredNamespaces, templateLint } from '@/shared/template-editor';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { quickStartApi } from '../api/client';
import {
  QUICK_START_STEPS,
  SCHEMA_PRESETS,
  presetByKey,
  runQuickStart,
  slugify,
  type QuickStartInput,
  type QuickStartStep,
  type QuickStartStepState,
} from '../lib/quick-start-plan';

const STEP_LABEL: Record<QuickStartStep, string> = {
  schema: 'Context schema',
  agent: 'Agent',
  workflow: 'Workflow',
  assignment: 'Assignment',
};

const STEP_LINK: Record<QuickStartStep, string> = {
  schema: 'Open the context schema',
  agent: 'Open the agent',
  workflow: 'Open the workflow',
  assignment: 'Open the assignments',
};

const TENANT_SCOPE = '__tenant__';

function Required() {
  return <span aria-hidden> *</span>;
}

function StepStatus({ state }: { state: QuickStartStepState | undefined }) {
  if (!state) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5">
        <IconCircleDashed aria-hidden className="size-4" />
        Not started
      </span>
    );
  }
  if (state.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <IconHourglass aria-hidden className="size-4" />
        Working
      </span>
    );
  }
  if (state.status === 'done') {
    return (
      <span className="text-success inline-flex items-center gap-1.5">
        <IconCheck aria-hidden className="size-4" />
        Done
      </span>
    );
  }
  return (
    <span className="text-destructive inline-flex items-center gap-1.5">
      <IconX aria-hidden className="size-4" />
      Failed: {state.message}
    </span>
  );
}

export function QuickStartBody() {
  const schemaOptions = useContextSchemaOptions();
  const departments = useDepartmentOptions();
  const catalogue = useModelCatalogue({ taskType: 'TEXT_GENERATION' });
  const models = useMemo(() => (catalogue.data?.models ?? []).filter((model) => model.usable), [catalogue.data]);

  const [schemaMode, setSchemaMode] = useState<'preset' | 'existing'>('preset');
  const [presetKey, setPresetKey] = useState(SCHEMA_PRESETS[0]?.key ?? '');
  const [schemaName, setSchemaName] = useState('Consultation context');
  const [existingSchemaId, setExistingSchemaId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [modelId, setModelId] = useState('');
  const [instructionMode, setInstructionMode] = useState<'inline' | 'template'>('inline');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [promptTemplateId, setPromptTemplateId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [assignTo, setAssignTo] = useState(TENANT_SCOPE);
  const [steps, setSteps] = useState<Partial<Record<QuickStartStep, QuickStartStepState>>>({});
  const [running, setRunning] = useState(false);

  // What `{{context.*}}` will resolve against — the preset's definition, or the chosen schema's pin.
  const existing = useContextSchemaDefinition(schemaMode === 'existing' && existingSchemaId ? existingSchemaId : null, null);
  const definition = schemaMode === 'preset' ? (presetByKey(presetKey)?.definition ?? null) : existing.definition;
  const paths = useMemo(() => contextVariablePaths(definition), [definition]);
  const lint = useMemo(() => templateLint(declaredNamespaces({ definition, variables: [] })), [definition]);

  const agentSlug = slugify(agentName);
  const effectiveWorkflowName = workflowName.trim() || (agentName.trim() ? `${agentName.trim()} workflow` : '');
  const workflowSlug = slugify(effectiveWorkflowName);
  const instructionReady = instructionMode === 'inline' ? systemPrompt.trim().length > 0 : promptTemplateId !== null;
  const schemaReady = schemaMode === 'preset' ? schemaName.trim().length > 0 && !!presetByKey(presetKey) : existingSchemaId.length > 0;
  const ready = schemaReady && agentSlug.length >= 2 && modelId.length > 0 && instructionReady && workflowSlug.length >= 2 && !running;
  const finished = QUICK_START_STEPS.every((step) => steps[step]?.status === 'done');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    const input: QuickStartInput = {
      schema: schemaMode === 'preset' ? { mode: 'preset', presetKey, name: schemaName.trim() } : { mode: 'existing', schemaId: existingSchemaId },
      agent: {
        name: agentName.trim(),
        slug: agentSlug,
        modelId,
        instruction: instructionMode === 'inline' ? { systemPrompt } : { promptTemplateId: promptTemplateId as string },
      },
      workflow: { name: effectiveWorkflowName, slug: workflowSlug },
      assignment: assignTo === TENANT_SCOPE ? { scope: 'TENANT' } : { scope: 'DEPARTMENT', departmentId: assignTo },
    };
    setSteps({});
    setRunning(true);
    try {
      await runQuickStart(input, quickStartApi, (step, state) => setSteps((current) => ({ ...current, [step]: state })));
    } finally {
      setRunning(false);
    }
  }

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Quick start"
          meta={<span>From a context schema to a workflow governing a department, in one pass. Every step makes an ordinary row you can refine in its own editor.</span>}
        />
      }
      footer={
        <StatusFooter
          start={<span>{running ? 'Creating…' : finished ? 'All four steps done' : 'Ready'}</span>}
          end={
            <span aria-hidden className="font-mono">
              POST /admin/agents · /admin/workflow-definitions · /admin/workflow-assignments
            </span>
          }
        />
      }
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-3xl flex-col gap-8">
        <fieldset className="flex flex-col gap-3" disabled={running}>
          <legend className="mb-2 text-base font-medium">1. Context schema</legend>
          <RadioGroup value={schemaMode} onValueChange={(next) => setSchemaMode(next as 'preset' | 'existing')} aria-label="Schema source">
            <div className="flex items-center gap-2">
              <RadioGroupItem id="qs-schema-preset" value="preset" />
              <Label htmlFor="qs-schema-preset">Start from a preset</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="qs-schema-existing" value="existing" />
              <Label htmlFor="qs-schema-existing">Use an existing schema</Label>
            </div>
          </RadioGroup>
          {schemaMode === 'preset' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qs-preset">Preset</Label>
                <Select value={presetKey} onValueChange={setPresetKey}>
                  <SelectTrigger id="qs-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEMA_PRESETS.map((preset) => (
                      <SelectItem key={preset.key} value={preset.key}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{presetByKey(presetKey)?.description}</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qs-schema-name">
                  Schema name
                  <Required />
                </Label>
                <Input id="qs-schema-name" value={schemaName} onChange={(event) => setSchemaName(event.target.value)} autoComplete="off" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qs-existing-schema">
                Schema
                <Required />
              </Label>
              <Select value={existingSchemaId} onValueChange={setExistingSchemaId}>
                <SelectTrigger id="qs-existing-schema" className="w-full">
                  <SelectValue placeholder={schemaOptions.options.length === 0 ? 'No published schemas yet' : 'Choose a schema'} />
                </SelectTrigger>
                <SelectContent>
                  {schemaOptions.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3" disabled={running}>
          <legend className="mb-2 text-base font-medium">2. Agent</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qs-agent-name">
                Agent name
                <Required />
              </Label>
              <Input id="qs-agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} autoComplete="off" />
              <p className="text-muted-foreground text-xs">
                Slug: <span className="font-mono">{agentSlug || '—'}</span>
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qs-model">
                Model
                <Required />
              </Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger id="qs-model" className="w-full">
                  <SelectValue placeholder={models.length === 0 ? 'No usable text-generation model' : 'Choose a model'} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                      {model.provider ? ` · ${model.provider}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <RadioGroup value={instructionMode} onValueChange={(next) => setInstructionMode(next as 'inline' | 'template')} aria-label="Instruction source">
            <div className="flex items-center gap-2">
              <RadioGroupItem id="qs-instruction-inline" value="inline" />
              <Label htmlFor="qs-instruction-inline">Write the system prompt here</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="qs-instruction-template" value="template" />
              <Label htmlFor="qs-instruction-template">Use an approved prompt template</Label>
            </div>
          </RadioGroup>
          {instructionMode === 'inline' ? (
            <TemplateField
              label="System prompt"
              required
              value={systemPrompt}
              onChange={setSystemPrompt}
              paths={paths}
              lint={lint}
              minLines={6}
              description="Type {{ to insert a field of the chosen schema."
            />
          ) : (
            <PromptTemplatePicker id="qs-template" value={promptTemplateId} onChange={setPromptTemplateId} />
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3" disabled={running}>
          <legend className="mb-2 text-base font-medium">3. Workflow</legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qs-workflow-name">Workflow name</Label>
            <Input
              id="qs-workflow-name"
              value={workflowName}
              placeholder={agentName.trim() ? `${agentName.trim()} workflow` : 'Defaults to the agent name'}
              onChange={(event) => setWorkflowName(event.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              Runs the agent when a consultation is opened against the schema. Slug: <span className="font-mono">{workflowSlug || '—'}</span>
            </p>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3" disabled={running}>
          <legend className="mb-2 text-base font-medium">4. Assignment</legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qs-assign">Assign to</Label>
            <Select value={assignTo} onValueChange={setAssignTo}>
              <SelectTrigger id="qs-assign" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TENANT_SCOPE}>Whole tenant (default)</SelectItem>
                {departments.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3">
          <Button type="submit" className="self-start" disabled={!ready}>
            {running ? <Spinner /> : null}
            Create and assign
          </Button>
          {!ready && !running ? <p className="text-muted-foreground text-xs">Fill every field marked * to continue.</p> : null}
          <ol aria-label="Progress" className="flex flex-col gap-2">
            {QUICK_START_STEPS.map((step, index) => (
              <li key={step} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm">
                <span className="w-40 font-medium">
                  {index + 1}. {STEP_LABEL[step]}
                </span>
                <StepStatus state={steps[step]} />
                {steps[step]?.href ? (
                  <a href={steps[step]?.href} className="text-primary ml-auto inline-flex items-center gap-1 underline-offset-4 hover:underline">
                    {STEP_LINK[step]}
                    <IconExternalLink aria-hidden className="size-3.5" />
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </form>
    </ScreenTemplate>
  );
}

export function QuickStartScreen() {
  return (
    <WorkingTenantGate
      title="Quick start"
      description="The quick start creates rows in one tenant. Pick a working tenant from the switcher in the top bar to begin."
    >
      <QuickStartBody />
    </WorkingTenantGate>
  );
}
