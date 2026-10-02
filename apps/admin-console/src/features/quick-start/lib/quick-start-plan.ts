/**
 * The quick start, as data: one context schema (a preset, or one the tenant already has) → one
 * text-generation agent bound to it → one workflow that runs that agent on the consultation
 * trigger → an assignment that makes the workflow govern a department (or the whole tenant).
 *
 * It drives the EXISTING admin endpoints in that order and stops at the first refusal, reporting
 * per step — every created row is a normal row the full editors open, and the quick start never
 * owns anything they do not. Pure over an injected `QuickStartApi`, so the sequence is testable
 * without a network.
 */

/** A starter definition offered when the tenant has no schema to bind yet. Authoring scaffolding only: the admin owns the published copy. */
export interface SchemaPreset {
  key: string;
  label: string;
  description: string;
  definition: Record<string, unknown>;
}

const DEFINITION_VERSION = '1.0';

export const SCHEMA_PRESETS: readonly SchemaPreset[] = [
  {
    key: 'consultation-note',
    label: 'Consultation note',
    description: 'The transcript plus a small patient and visit record — enough for a first clinical note.',
    definition: {
      schemaVersion: DEFINITION_VERSION,
      kinds: [
        {
          key: 'transcript',
          label: 'Transcript',
          primitive: 'TEXT',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'DURING',
          producedBy: ['SYSTEM'],
          required: true,
          description: 'The consultation transcript.',
        },
        {
          key: 'patient',
          label: 'Patient',
          primitive: 'STRUCTURED',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'PRE',
          producedBy: ['CLIENT'],
          required: false,
          fields: {
            type: 'object',
            properties: {
              age: { type: 'integer', minimum: 0, description: 'Age in whole years.' },
              sex: { type: 'string', description: 'Sex as recorded.' },
            },
          },
        },
        {
          key: 'visit',
          label: 'Visit',
          primitive: 'STRUCTURED',
          phiClass: 'NON_PHI',
          cardinality: 'ONE',
          lifecycle: 'PRE',
          producedBy: ['CLIENT'],
          required: false,
          fields: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Reason for the visit.' },
            },
          },
        },
      ],
      outputs: [],
    },
  },
  {
    key: 'transcript-only',
    label: 'Transcript only',
    description: 'Just the consultation transcript — the smallest useful context.',
    definition: {
      schemaVersion: DEFINITION_VERSION,
      kinds: [
        {
          key: 'transcript',
          label: 'Transcript',
          primitive: 'TEXT',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'DURING',
          producedBy: ['SYSTEM'],
          required: true,
          description: 'The consultation transcript.',
        },
      ],
      outputs: [],
    },
  },
];

export function presetByKey(key: string): SchemaPreset | undefined {
  return SCHEMA_PRESETS.find((preset) => preset.key === key);
}

/** The palette a quick-start workflow is created in — the core node vocabulary. */
export const QUICK_START_PALETTE = 'core';

export interface QuickStartGraph {
  version: 1;
  nodes: { id: string; type: string; config: Record<string, unknown>; position: { x: number; y: number } }[];
  edges: { id: string; from: string; fromPort: string; to: string; toPort: string }[];
}

/** consultation trigger (bound to the schema, following its pin) → the agent → output. */
export function quickStartGraph({ contextSchemaId, agentSlug }: { contextSchemaId: string; agentSlug: string }): QuickStartGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'core.trigger', config: { kinds: ['consultation'], contextSchema: { contextSchemaId } }, position: { x: 0, y: 0 } },
      { id: 'agent', type: 'core.agent', config: { agentRef: { slug: agentSlug } }, position: { x: 280, y: 0 } },
      { id: 'output', type: 'core.output', config: {}, position: { x: 560, y: 0 } },
    ],
    edges: [
      { id: 'trigger-agent', from: 'trigger', fromPort: 'out', to: 'agent', toPort: 'context' },
      { id: 'agent-output', from: 'agent', fromPort: 'out', to: 'output', toPort: 'in' },
    ],
  };
}

export type QuickStartInstruction = { promptTemplateId: string } | { systemPrompt: string };

export interface QuickStartInput {
  schema: { mode: 'preset'; presetKey: string; name: string } | { mode: 'existing'; schemaId: string };
  agent: { name: string; slug: string; modelId: string; instruction: QuickStartInstruction };
  workflow: { name: string; slug: string };
  assignment: { scope: 'TENANT' } | { scope: 'DEPARTMENT'; departmentId: string };
}

/** The admin endpoints the quick start drives — each returns the created/published row's identity. */
export interface QuickStartApi {
  createContextSchema(body: { slug: string; name: string }): Promise<{ id: string }>;
  publishContextSchema(id: string, body: { definition: Record<string, unknown>; changeReason?: string }): Promise<{ id: string }>;
  createAgent(body: Record<string, unknown>): Promise<{ id: string; slug: string }>;
  publishAgent(id: string, body: { activate: boolean }): Promise<{ id: string; slug: string }>;
  createWorkflowDefinition(body: { slug: string; name: string; paletteKey: string; graph: QuickStartGraph }): Promise<{ id: string; slug: string }>;
  publishWorkflowDefinition(id: string, body: { activate: boolean }): Promise<{ id: string; slug: string }>;
  createWorkflowAssignment(body: {
    scope: 'TENANT' | 'DEPARTMENT';
    scopeId?: string | null;
    paletteKey: string;
    workflowDefinitionSlug: string;
    reason?: string;
  }): Promise<{ id: string }>;
}

export const QUICK_START_STEPS = ['schema', 'agent', 'workflow', 'assignment'] as const;
export type QuickStartStep = (typeof QUICK_START_STEPS)[number];

export interface QuickStartStepState {
  status: 'running' | 'done' | 'error';
  /** Where the full editor for this step's row lives. */
  href?: string;
  message?: string;
}

/** A slug from a display name: the lineage-key grammar the agent and workflow routes enforce. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The request was refused.';
}

export async function runQuickStart(
  input: QuickStartInput,
  api: QuickStartApi,
  onStep: (step: QuickStartStep, state: QuickStartStepState) => void,
): Promise<{ ok: boolean }> {
  async function step<T>(name: QuickStartStep, work: () => Promise<{ value: T; href: string }>): Promise<T | undefined> {
    onStep(name, { status: 'running' });
    try {
      const { value, href } = await work();
      onStep(name, { status: 'done', href });
      return value;
    } catch (error) {
      onStep(name, { status: 'error', message: messageOf(error) });
      return undefined;
    }
  }

  const schema = await step('schema', async () => {
    if (input.schema.mode === 'existing') return { value: input.schema.schemaId, href: `/context-schemas/${encodeURIComponent(input.schema.schemaId)}` };
    const preset = presetByKey(input.schema.presetKey);
    if (!preset) throw new Error(`Unknown preset "${input.schema.presetKey}".`);
    const created = await api.createContextSchema({ slug: slugify(input.schema.name).replace(/-/g, '_').slice(0, 48), name: input.schema.name });
    await api.publishContextSchema(created.id, { definition: preset.definition, changeReason: `Quick start: ${preset.label} preset` });
    return { value: created.id, href: `/context-schemas/${encodeURIComponent(created.id)}` };
  });
  if (schema === undefined) return { ok: false };
  const schemaId = schema;

  const agent = await step('agent', async () => {
    const created = await api.createAgent({
      slug: input.agent.slug,
      name: input.agent.name,
      task: 'TEXT_GENERATION',
      modelId: input.agent.modelId,
      contextSchemaId: schemaId,
      contextSchemaVersionNumber: null,
      instruction: input.agent.instruction,
    });
    const published = await api.publishAgent(created.id, { activate: true });
    return { value: published.slug, href: `/agents?slug=${encodeURIComponent(published.slug)}` };
  });
  if (agent === undefined) return { ok: false };

  const workflow = await step('workflow', async () => {
    const created = await api.createWorkflowDefinition({
      slug: input.workflow.slug,
      name: input.workflow.name,
      paletteKey: QUICK_START_PALETTE,
      graph: quickStartGraph({ contextSchemaId: schemaId, agentSlug: agent }),
    });
    await api.publishWorkflowDefinition(created.id, { activate: true });
    return { value: created.slug, href: `/workflow-studio/${encodeURIComponent(created.id)}` };
  });
  if (workflow === undefined) return { ok: false };
  const workflowSlug = workflow;

  const assigned = await step('assignment', async () => {
    await api.createWorkflowAssignment({
      scope: input.assignment.scope,
      scopeId: input.assignment.scope === 'DEPARTMENT' ? input.assignment.departmentId : null,
      paletteKey: QUICK_START_PALETTE,
      workflowDefinitionSlug: workflowSlug,
      reason: 'Quick start',
    });
    return { value: true, href: '/workflow-studio/assignments' };
  });
  return { ok: assigned === true };
}
