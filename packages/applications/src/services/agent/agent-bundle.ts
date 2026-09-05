/**
 * The AGENT bundle payload — what travels inside a `PortableBundle` of kind `'agent'`
 * (TASK-884, owner decision #4: "tenant admins import/export agents as JSON").
 *
 * ## The one rule the whole file follows
 *
 * A bundle carries VALUES; anything that is only meaningful inside the tenant that owns it is
 * either rewritten into something re-resolvable or refused. That is the `AgentPromotion`
 * discipline applied to a file instead of a database write, and it is why an import can fail
 * with a NAMED 409 rather than producing a half-configured agent:
 *
 * | On the row | In the bundle | On import |
 * |---|---|---|
 * | `modelId` (a registry row id) | `modelSlug` | re-resolved against the importer's visible catalogue; unresolvable ⇒ 409 naming the slug |
 * | `fallbackModelIds[]` | `fallbackModelSlugs[]` | same, in order |
 * | `instruction.promptTemplateId` | `instruction.promptTemplateRef` — `{ kind: 'system', id, name }` or `{ kind: 'tenant', name }` | a SYSTEM id is genuinely portable (`SYSTEM_SHARED_READ_MODELS`) and is kept; a tenant template is re-resolved BY NAME in the importing tenant, unresolvable ⇒ 409 |
 * | `instruction.evalGate` | STRIPPED | `goldenSetId` names a corpus of Vault-Transit-encrypted `GoldenCase` PHI. Not even the pointer leaves the tenant |
 * | `instruction.promptVersionNumber` | carried | kept only when the SAME row resolved; dropped when the template was re-resolved by name, because version lineages are per-tenant |
 * | `tools[].mcpServerId` | carried verbatim | each must be an ENABLED server visible to the importer; otherwise 409. An id is opaque but checkable, and dropping the bindings silently would import an agent that quietly cannot do its job |
 * | every server-owned column (`compiledConfig`, `validationReport`, `status`, `isActive`, `versionNumber`, ids, timestamps, `tenantId`) | ABSENT | an import always lands a DRAFT the importing tenant validates and publishes itself |
 *
 * A credential never appears: an agent does not carry one in the first place (the model row
 * decides the engine, the tenant's `AiProviderConnection` decides the key), so there is nothing
 * to strip — which is exactly why this export is safe to hand to a person.
 *
 * `notes` records what the EXPORT dropped, so a round-trip is honest about being lossy rather
 * than looking complete and silently missing an eval gate.
 */
import { AGENT_TASKS, agentTagProblems, type PortableBundleProblem } from '@arcaai/workflow-contract';

/** How a bound prompt template travels: portable by id when SYSTEM's, by name when the tenant's own. */
export interface AgentBundlePromptTemplateRef {
  readonly kind: 'system' | 'tenant';
  /** Only for `kind: 'system'` — a SYSTEM template id is readable from every tenant. */
  readonly id?: string;
  /** The template's name, which is unique per tenant and is what a tenant-owned ref re-resolves on. */
  readonly name: string;
}

export interface AgentBundlePayload {
  slug: string;
  name: string;
  description: string | null;
  task: string;
  modelSlug: string;
  fallbackModelSlugs: string[];
  instruction: Record<string, unknown> | null;
  parameters: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  tools: Array<Record<string, unknown>> | null;
  tags: string[];
  /** What the export deliberately did not carry. Surfaced to the importer as warnings. */
  notes: string[];
}

/** The instruction key an exported bundle uses in place of a tenant-scoped template id. */
export const PROMPT_TEMPLATE_REF_KEY = 'promptTemplateRef';
export const PROMPT_TEMPLATE_ID_KEY = 'promptTemplateId';
export const PROMPT_VERSION_NUMBER_KEY = 'promptVersionNumber';
export const EVAL_GATE_KEY = 'evalGate';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function asArray(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : null;
}

/**
 * Rewrite one agent's `instruction` for EXPORT: the tenant-scoped template id becomes a
 * re-resolvable ref, and the eval gate is dropped (with a note saying so).
 *
 * `template` is what the caller resolved for the bound id — `null` when the binding no longer
 * resolves, which is recorded as a note rather than silently exported as a dangling id.
 */
export function instructionForExport(
  instruction: Record<string, unknown> | null,
  template: { id: string; name: string; isSystemOwned: boolean } | null,
  notes: string[],
): Record<string, unknown> | null {
  if (!instruction) return null;
  const out: Record<string, unknown> = { ...instruction };

  if (EVAL_GATE_KEY in out) {
    delete out[EVAL_GATE_KEY];
    notes.push(
      'The eval gate was not exported: a golden set is a corpus of encrypted patient data and its pointer never leaves the tenant. Re-bind one after importing.',
    );
  }

  const boundId = out[PROMPT_TEMPLATE_ID_KEY];
  if (typeof boundId === 'string' && boundId.length > 0) {
    delete out[PROMPT_TEMPLATE_ID_KEY];
    if (!template) {
      delete out[PROMPT_VERSION_NUMBER_KEY];
      notes.push(
        `The bound prompt template (${boundId}) could not be read and was not exported; the imported agent will need one bound before it can be published.`,
      );
    } else if (template.isSystemOwned) {
      out[PROMPT_TEMPLATE_REF_KEY] = { kind: 'system', id: template.id, name: template.name } satisfies AgentBundlePromptTemplateRef;
    } else {
      out[PROMPT_TEMPLATE_REF_KEY] = { kind: 'tenant', name: template.name } satisfies AgentBundlePromptTemplateRef;
    }
  }

  return out;
}

/** The ref an exported instruction carries, or `null` when it binds no template. */
export function readPromptTemplateRef(instruction: Record<string, unknown> | null): AgentBundlePromptTemplateRef | null {
  const ref = asObject(instruction?.[PROMPT_TEMPLATE_REF_KEY]);
  if (!ref) return null;
  const kind = ref.kind;
  const name = ref.name;
  if ((kind !== 'system' && kind !== 'tenant') || typeof name !== 'string' || name.length === 0) return null;
  return { kind, name, ...(typeof ref.id === 'string' ? { id: ref.id } : {}) };
}

/**
 * Turn an exported instruction back into a storable one: the ref becomes the id the importer
 * resolved, and the version pin survives only when the SAME row resolved.
 */
export function instructionForImport(
  instruction: Record<string, unknown> | null,
  resolved: { templateId: string; keepVersionPin: boolean } | null,
): Record<string, unknown> | null {
  if (!instruction) return null;
  const out: Record<string, unknown> = { ...instruction };
  delete out[PROMPT_TEMPLATE_REF_KEY];
  if (resolved) {
    out[PROMPT_TEMPLATE_ID_KEY] = resolved.templateId;
    if (!resolved.keepVersionPin) delete out[PROMPT_VERSION_NUMBER_KEY];
  }
  return out;
}

/** The `mcpServerId`s a payload's tool bindings name, de-duplicated and in order. */
export function toolServerIds(tools: Array<Record<string, unknown>> | null): string[] {
  const ids: string[] = [];
  for (const tool of tools ?? []) {
    const id = tool?.mcpServerId;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Structural problems with an agent payload — the shape checks that must pass before the
 * importer starts RESOLVING anything, so a malformed file is a 400 about its shape rather than
 * a confusing 409 about a model slug it never really named.
 */
export function agentBundlePayloadProblems(value: unknown): PortableBundleProblem[] {
  if (!isPlainObject(value)) return [{ path: 'payload', message: 'The agent payload must be a JSON object.' }];
  const problems: PortableBundleProblem[] = [];

  for (const field of ['slug', 'name', 'modelSlug'] as const) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) {
      problems.push({ path: `payload.${field}`, message: `\`${field}\` is required.` });
    }
  }
  if (typeof value.task !== 'string' || !(AGENT_TASKS as readonly string[]).includes(value.task)) {
    problems.push({ path: 'payload.task', message: `\`task\` must be one of ${AGENT_TASKS.join(', ')}.` });
  }
  if (value.fallbackModelSlugs !== undefined && !Array.isArray(value.fallbackModelSlugs)) {
    problems.push({ path: 'payload.fallbackModelSlugs', message: '`fallbackModelSlugs` must be an array of registry slugs.' });
  } else if (Array.isArray(value.fallbackModelSlugs) && value.fallbackModelSlugs.some((slug) => typeof slug !== 'string')) {
    problems.push({ path: 'payload.fallbackModelSlugs', message: '`fallbackModelSlugs` must be an array of registry slugs.' });
  }
  for (const field of ['instruction', 'parameters', 'inputSchema', 'outputSchema'] as const) {
    const entry = value[field];
    if (entry !== undefined && entry !== null && !isPlainObject(entry)) {
      problems.push({ path: `payload.${field}`, message: `\`${field}\` must be a JSON object when present.` });
    }
  }
  if (value.tools !== undefined && value.tools !== null && !Array.isArray(value.tools)) {
    problems.push({ path: 'payload.tools', message: '`tools` must be an array of `{ mcpServerId, toolName }` references when present.' });
  }
  // A bundle authored before the key:value grammar, or hand-edited, is refused here rather
  // than importing tags that no selector could ever match.
  for (const problem of agentTagProblems(value.tags ?? [], 'payload.tags')) {
    problems.push({ path: problem.path, message: problem.message });
  }
  // A server-owned column in a hand-edited file is a REFUSAL, not something to quietly ignore:
  // whoever wrote it expected it to take effect.
  for (const forbidden of [
    'id',
    'tenantId',
    'versionNumber',
    'status',
    'isActive',
    'compiledConfig',
    'compiledConfigChecksum',
    'validationReport',
    'modelId',
  ]) {
    if (forbidden in value) {
      problems.push({
        path: `payload.${forbidden}`,
        message: `\`${forbidden}\` is server-owned and is never part of a bundle; an import always lands a DRAFT the importing tenant publishes itself.`,
      });
    }
  }

  return problems;
}

/** Build the exportable payload from an already-read row. Pure — every resolution is the caller's. */
export function buildAgentBundlePayload(input: {
  slug: string;
  name: string;
  description: string | null;
  task: string;
  modelSlug: string;
  fallbackModelSlugs: string[];
  instruction: unknown;
  parameters: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  tools: unknown;
  tags: string[];
  boundTemplate: { id: string; name: string; isSystemOwned: boolean } | null;
}): AgentBundlePayload {
  const notes: string[] = [];
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    task: input.task,
    modelSlug: input.modelSlug,
    fallbackModelSlugs: [...input.fallbackModelSlugs],
    instruction: instructionForExport(asObject(input.instruction), input.boundTemplate, notes),
    parameters: asObject(input.parameters),
    inputSchema: asObject(input.inputSchema),
    outputSchema: asObject(input.outputSchema),
    tools: asArray(input.tools),
    tags: [...input.tags],
    notes,
  };
}
