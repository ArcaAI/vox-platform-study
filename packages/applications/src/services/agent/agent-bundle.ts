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
import { AGENT_TASKS, agentTagProblems, boundTemplateRefs, type PortableBundleProblem } from '@arcaai/workflow-contract';

/** How a bound prompt template travels: portable by id when SYSTEM's, by name when the tenant's own. */
export interface AgentBundlePromptTemplateRef {
  readonly kind: 'system' | 'tenant';
  /** Only for `kind: 'system'` — a SYSTEM template id is readable from every tenant. */
  readonly id?: string;
  /** The template's name, which is unique per tenant and is what a tenant-owned ref re-resolves on. */
  readonly name: string;
}

/** One template row an export resolved, as the bundle needs to describe it. */
export interface AgentBundleBoundTemplate {
  readonly id: string;
  readonly name: string;
  readonly isSystemOwned: boolean;
}

/**
 * WHERE an exported instruction carries a `promptTemplateRef`, and what it says (TASK-947).
 *
 * `path` is the address the importer resolves against — `instruction` for the single-template
 * form, `instruction.fragments[i]` for a composite. It is what a 409 names, and it is the key
 * `instructionForImport` looks each resolution up under, so a composite binding two templates
 * cannot land both fragments on whichever one resolved first.
 */
export interface AgentBundleTemplateRefSite {
  readonly path: string;
  readonly fragmentIndex: number | null;
  readonly fragmentKey: string | null;
  readonly ref: AgentBundlePromptTemplateRef;
}

/** What the importer decided for ONE ref site. */
export interface AgentBundleTemplateResolution {
  readonly templateId: string;
  readonly keepVersionPin: boolean;
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
 * A NEW instruction with `edit` applied to every object that CARRIES a template binding — the
 * instruction itself for the single-template form, or each named fragment for a composite.
 *
 * `sites` names the fragment indices to edit (`null` = the instruction root), which is exactly
 * what `boundTemplateRefs` and `readPromptTemplateRefs` answer. Nothing is mutated: an export
 * must not rewrite the row it read, and an import must not rewrite the caller's bundle.
 */
function editBindingSites(
  instruction: Record<string, unknown>,
  sites: ReadonlyArray<{ fragmentIndex: number | null }>,
  edit: (target: Record<string, unknown>, site: { fragmentIndex: number | null }) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...instruction };
  const rootSite = sites.find((site) => site.fragmentIndex === null);
  if (rootSite) edit(out, rootSite);

  const byIndex = new Map(sites.filter((site) => site.fragmentIndex !== null).map((site) => [site.fragmentIndex, site]));
  if (byIndex.size > 0 && Array.isArray(out.fragments)) {
    out.fragments = (out.fragments as unknown[]).map((raw, index) => {
      const site = byIndex.get(index);
      if (!site || !isPlainObject(raw)) return raw;
      const fragment: Record<string, unknown> = { ...raw };
      edit(fragment, site);
      return fragment;
    });
  }
  return out;
}

/**
 * Rewrite one agent's `instruction` for EXPORT: every tenant-scoped template id becomes a
 * re-resolvable ref, and the eval gate is dropped (with a note saying so).
 *
 * `templates` is what the caller resolved, BY ROW ID. A binding missing from it no longer
 * resolves, which is recorded as a note rather than silently exported as a dangling id — and
 * since TASK-947 that judgement is made per FRAGMENT, so a composite whose second template was
 * deleted exports the rest of itself and says which fragment it lost.
 */
export function instructionForExport(
  instruction: Record<string, unknown> | null,
  templates: ReadonlyMap<string, AgentBundleBoundTemplate>,
  notes: string[],
): Record<string, unknown> | null {
  if (!instruction) return null;
  const withoutGate: Record<string, unknown> = { ...instruction };

  if (EVAL_GATE_KEY in withoutGate) {
    delete withoutGate[EVAL_GATE_KEY];
    notes.push(
      'The eval gate was not exported: a golden set is a corpus of encrypted patient data and its pointer never leaves the tenant. Re-bind one after importing.',
    );
  }

  // The TRAVERSAL is the contract's (`boundTemplateRefs`), so a form this file has never heard
  // of still has every one of its bindings found; only the WRITE is local, because swapping an
  // id key for a ref key is a bundle concern the contract knows nothing about.
  const refs = boundTemplateRefs(withoutGate);
  if (refs.length === 0) return withoutGate;

  const byIndex = new Map(refs.map((ref) => [ref.fragmentIndex, ref]));
  return editBindingSites(withoutGate, refs, (target, site) => {
    const ref = byIndex.get(site.fragmentIndex);
    if (!ref) return;
    delete target[PROMPT_TEMPLATE_ID_KEY];
    const template = templates.get(ref.templateId);
    if (!template) {
      delete target[PROMPT_VERSION_NUMBER_KEY];
      notes.push(
        `The prompt template bound at \`${ref.path}\` (${ref.templateId}) could not be read and was not exported; ` +
          'the imported agent will need one bound before it can be published.',
      );
      return;
    }
    target[PROMPT_TEMPLATE_REF_KEY] = (
      template.isSystemOwned ? { kind: 'system', id: template.id, name: template.name } : { kind: 'tenant', name: template.name }
    ) satisfies AgentBundlePromptTemplateRef;
  });
}

/** One `promptTemplateRef` value, or `null` when the object carries none (or a malformed one). */
function readRef(value: unknown): AgentBundlePromptTemplateRef | null {
  const ref = asObject(value);
  if (!ref) return null;
  const kind = ref.kind;
  const name = ref.name;
  if ((kind !== 'system' && kind !== 'tenant') || typeof name !== 'string' || name.length === 0) return null;
  return { kind, name, ...(typeof ref.id === 'string' ? { id: ref.id } : {}) };
}

/**
 * Every ref an EXPORTED instruction carries, in authored order.
 *
 * This one does NOT go through `boundTemplateRefs`: an exported instruction has no
 * `promptTemplateId` left to find — that is the point of the export — so the sites are found on
 * the bundle's own key. The shape of the fragment list is still the contract's
 * (`readPromptFragments` decides what counts as a fragment).
 */
export function readPromptTemplateRefs(instruction: Record<string, unknown> | null): AgentBundleTemplateRefSite[] {
  if (!instruction) return [];
  const sites: AgentBundleTemplateRefSite[] = [];

  const root = readRef(instruction[PROMPT_TEMPLATE_REF_KEY]);
  if (root) sites.push({ path: 'instruction', fragmentIndex: null, fragmentKey: null, ref: root });

  if (Array.isArray(instruction.fragments)) {
    (instruction.fragments as unknown[]).forEach((raw, index) => {
      if (!isPlainObject(raw)) return;
      const ref = readRef(raw[PROMPT_TEMPLATE_REF_KEY]);
      if (!ref) return;
      sites.push({
        path: `instruction.fragments[${index}]`,
        fragmentIndex: index,
        fragmentKey: typeof raw.key === 'string' ? raw.key : null,
        ref,
      });
    });
  }
  return sites;
}

/**
 * Turn an exported instruction back into a storable one: each ref becomes the id the importer
 * resolved for THAT SITE, and a version pin survives only where the same row resolved.
 *
 * Keyed by `path` rather than by template name, because two fragments may legitimately bind the
 * same template at different versions — and because a site the importer did not resolve must
 * lose its ref rather than inherit a neighbour's id.
 */
export function instructionForImport(
  instruction: Record<string, unknown> | null,
  resolved: ReadonlyMap<string, AgentBundleTemplateResolution>,
): Record<string, unknown> | null {
  if (!instruction) return null;
  // EVERY binding-capable object, not just the ones carrying a well-formed ref: the ref key is
  // the bundle's own and must never reach a stored row, malformed included.
  const sites: Array<{ fragmentIndex: number | null; path: string }> = [{ fragmentIndex: null, path: 'instruction' }];
  if (Array.isArray(instruction.fragments)) {
    (instruction.fragments as unknown[]).forEach((_raw, index) => sites.push({ fragmentIndex: index, path: `instruction.fragments[${index}]` }));
  }
  const byIndex = new Map(sites.map((site) => [site.fragmentIndex, site.path]));

  return editBindingSites(instruction, sites, (target, site) => {
    delete target[PROMPT_TEMPLATE_REF_KEY];
    const resolution = resolved.get(byIndex.get(site.fragmentIndex) ?? '');
    if (!resolution) return;
    target[PROMPT_TEMPLATE_ID_KEY] = resolution.templateId;
    if (!resolution.keepVersionPin) delete target[PROMPT_VERSION_NUMBER_KEY];
  });
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
  // TASK-947 — a bundle NEVER carries a raw `promptTemplateId`: the export rewrites every one of
  // them into a `promptTemplateRef` precisely because a row id means nothing (or, worse, means
  // something ELSE) in the importing tenant. One in a hand-edited file is a REFUSAL, not
  // something to import and hope about — and the composite form is what makes this worth
  // checking, since a file can now smuggle one onto fragment 7 where nobody would look.
  const instruction = asObject(value.instruction);
  if (instruction) {
    for (const ref of boundTemplateRefs(instruction)) {
      problems.push({
        path: `payload.${ref.path}.${PROMPT_TEMPLATE_ID_KEY}`,
        message: `\`${PROMPT_TEMPLATE_ID_KEY}\` is a tenant-scoped row id and is never part of a bundle; an export carries \`${PROMPT_TEMPLATE_REF_KEY}\` instead.`,
      });
    }
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
  /** Every template the instruction binds, resolved by the caller, keyed by ROW ID. */
  boundTemplates: ReadonlyMap<string, AgentBundleBoundTemplate>;
}): AgentBundlePayload {
  const notes: string[] = [];
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    task: input.task,
    modelSlug: input.modelSlug,
    fallbackModelSlugs: [...input.fallbackModelSlugs],
    instruction: instructionForExport(asObject(input.instruction), input.boundTemplates, notes),
    parameters: asObject(input.parameters),
    inputSchema: asObject(input.inputSchema),
    outputSchema: asObject(input.outputSchema),
    tools: asArray(input.tools),
    tags: [...input.tags],
    notes,
  };
}
