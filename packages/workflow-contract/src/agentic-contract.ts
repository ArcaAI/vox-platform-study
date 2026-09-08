/**
 * The `agentic` catalogue's checks that a JSON Schema cannot express ( steps 3, 5, 6 and
 * the risk-1 guard), plus the mechanical form of the ticket's most important rule.
 *
 * ## Why these are not in `node-config-schemas.ts`
 *
 * Three different reasons, worth separating because they suggest different homes for future
 * additions:
 *
 *  - **`exactly one of`** — JSON Schema says this with `oneOf`, and the authorable subset
 *    (`@arcaai/json-schema-subset`) requires a sibling `discriminator.propertyName` on every
 *    `oneOf`. `providerConfigRef`'s two shapes have no discriminating property — the shape IS
 *    which key is present — so the constraint cannot be authored. It lives here instead.
 *  - **cross-node references** — `guards.input[]`, `orchestratorNodeId` and `subAgentNodeIds`
 *    name OTHER nodes. A per-node schema has no view of the graph.
 *  - **provider capability** — the answer is DATA (it comes off the resolved provider row), and
 *    this package has zero runtime dependencies and no database access. The pure function is
 *    here; the caller supplies the capability set.
 *
 * ## Everything here returns problems, never throws
 *
 * Same idiom as `port-validation.ts` and `@arcaai/json-schema-subset`: a `string[]` of
 * publish-blocking problems, or (where severity varies) a typed record carrying it. The caller
 * wraps them into `WorkflowFinding`s.
 */
import type { NodeConfigSchema } from './node-config-schemas';

// =============================================================================================
// The reference-only guard (risk 1) — the single most important review item in Track D
// =============================================================================================
//
// > *A node schema stores a model id, endpoint or key in graph JSON — silently bypassing the
// > tenant→SYSTEM cascade AND BYOK funding derivation.*
//
// The second half is what makes this a SILENT defect. Funding is derived from
// `row.tenantId === SYSTEM_TENANT_ID`, so a graph carrying its own endpoint does not fail — it
// serves, and it bills the wrong party, with nothing anywhere to say so. A loud failure would be
// a far smaller problem than the one this exists to prevent.
//
// Two directions, because each catches what the other cannot:
//
//   `forbiddenSchemaKeyProblems` — no node config schema DECLARES a property that could hold a
//                                   resolved value. With `additionalProperties: false` on every
//                                   schema, what is not declared cannot be authored.
//   `compiledGraphLeakProblems` — the artifact that actually reaches Temporal is walked for
//                                   forbidden keys AND for secret-SHAPED values, so an endpoint
//                                   smuggled under an innocent key name is still caught.

/**
 * Property names a workflow graph may never carry. EXACT names (case-insensitive), not
 * substrings, and that precision is deliberate: `audioUri` is a legitimate artifact reference,
 * `maxTokens` is a hyper-parameter, `modelSlug` is a catalogue REFERENCE resolved through the
 * cascade. A substring match would flag all three and the rule would be turned off within a
 * week.
 *
 * The three groups are the three ways a graph could route around the cascade:
 *
 *  - **authenticate** — a credential in graph data is both a cascade bypass and a plaintext
 *    secret in a DB column (`09-infrastructure-devops.md` §9.3 M10).
 *  - **address** — an endpoint decides WHICH deployment serves, so it selects a provider without
 *    an `AiProviderConnection` row, and therefore without an enabled check or a funding tier.
 *  - **name the wire model** — a provider-native model id (`deploymentName`, `modelRef`) is what
 *    the adapter puts on the request. Naming it here skips the `AiModel` row that carries the
 *    task-type match, the enabled flag and the runtime profile.
 */
export const FORBIDDEN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // authenticate
  'apikey',
  'api_key',
  'secret',
  'secrets',
  'secretkey',
  'secret_key',
  'clientsecret',
  'client_secret',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'token',
  'accesstoken',
  'access_token',
  'authtoken',
  'auth_token',
  'bearertoken',
  'authorization',
  'privatekey',
  'private_key',
  // address
  'endpoint',
  'endpointurl',
  'endpoint_url',
  'baseurl',
  'base_url',
  'apibase',
  'api_base',
  'apiurl',
  'api_url',
  'host',
  'hostname',
  'port',
  'sourceuri',
  'source_uri',
  // name the wire model / the engine
  'provider',
  'providername',
  'provider_name',
  'engine',
  'enginename',
  'engine_name',
  'model',
  'modelname',
  'model_name',
  'modelref',
  'model_ref',
  'deployment',
  'deploymentname',
  'deployment_name',
]);

/** The canonical spelling of each forbidden key, for a readable message. */
function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_CONFIG_KEYS.has(normalizeKey(key));
}

/**
 * DIRECTION 1 — scan every authored node config schema for a declared property that could hold a
 * resolved credential, endpoint or wire model id. Walks `properties` and `items` recursively;
 * `$id`, `title` and the rest of a schema's own keywords are not property names and are skipped.
 */
export function forbiddenSchemaKeyProblems(schemas: Readonly<Record<string, NodeConfigSchema | undefined>>): string[] {
  const problems: string[] = [];

  function walk(schema: unknown, nodeType: string, path: string): void {
    if (schema === null || typeof schema !== 'object') return;
    const node = schema as Record<string, unknown>;
    const properties = node.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
        if (isForbiddenKey(name)) {
          problems.push(
            `${nodeType}${path}/properties/${name}: a node config schema may not declare \`${name}\` — a workflow graph stores REFERENCES only, never a resolved credential, endpoint or provider-native model id (§3.4 rule 16).`,
          );
        }
        walk(sub, nodeType, `${path}/properties/${name}`);
      }
    }
    if (node.items !== undefined) walk(node.items, nodeType, `${path}/items`);
  }

  for (const [nodeType, schema] of Object.entries(schemas)) {
    if (schema === undefined) continue;
    walk(schema, nodeType, '');
  }
  return problems;
}

/**
 * Value shapes that are a resolved credential or endpoint no matter what key they arrive under.
 *
 * Deliberately narrow. This is a leak DETECTOR on a compiled artifact, and a false positive here
 * blocks a publish — so it matches only things that cannot plausibly be anything else: a URL with
 * a scheme, a PEM block, and the vendor key prefixes that are themselves designed to be
 * recognisable. It is the backstop for direction 1, not a general secret scanner (`gitleaks` is
 * that, and it runs over the repo, not over runtime data).
 */
const LEAKED_VALUE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'a URL — an endpoint is selected by an `AiProviderConnection` row, never by graph data', pattern: /^[a-z][a-z0-9+.-]*:\/\/\S/i },
  { label: 'a PEM-encoded key', pattern: /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/ },
  { label: 'a vendor API key', pattern: /^(sk-|sk_|rk_|hf_|ghp_|gho_|xoxb-|AKIA|ASIA)[A-Za-z0-9_-]{8,}/ },
  { label: 'an Authorization header value', pattern: /^Bearer\s+\S{8,}/i },
];

/**
 * DIRECTION 2 — walk a COMPILED workflow config for anything resolved.
 *
 * Takes `unknown` rather than `CompiledWorkflowConfig` on purpose: this is a guard against an
 * artifact that may have been assembled somewhere other than `compile()`, and typing the
 * parameter to the shape produced by the code you are guarding against defeats the guard.
 */
export function compiledGraphLeakProblems(compiled: unknown): string[] {
  const problems: string[] = [];

  function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
        if (isForbiddenKey(key)) {
          problems.push(
            `${path}/${key}: a compiled workflow graph may not carry \`${key}\` — store a REFERENCE and resolve it in the activity (§3.4 rule 16).`,
          );
          continue;
        }
        walk(sub, `${path}/${key}`);
      }
      return;
    }
    if (typeof value !== 'string') return;
    for (const { label, pattern } of LEAKED_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        problems.push(`${path}: the value looks like ${label}. A compiled workflow graph carries references only.`);
        return;
      }
    }
  }

  walk(compiled, '');
  return problems;
}

// =============================================================================================
// Hyper-parameter capability gating
// =============================================================================================

/**
 * The closed vocabulary of CAPABILITY-GATED generation keys.
 *
 * The first seven are what the generic agent node offers under `config.generation`. `reasoning`
 * (TASK-891 C1 / OD-4) is authorable on the AGENT only — `AGENT_PARAMETER_SCHEMAS[...]`'s
 * `parameters.generation.reasoning` — and the node's own block deliberately does not offer it.
 * It belongs in this list all the same, because ONE capability declaration
 * (`AiModel._metadata.supportedGenerationParams`) gates BOTH surfaces through
 * `hyperparameterCapabilityProblems`: a row that may not declare `reasoning` cannot express that
 * its engine honours it, which is how a seeded, already-published agent came to be unpublishable
 * (TASK-930 D-6). It is also what makes that refusal report as `CAPABILITY` rather than `CONFIG`
 * (`agent-findings.ts#codeForConfigProblem`), which is what it is.
 */
export const GENERATION_HYPERPARAMETERS = [
  'temperature',
  'maxTokens',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'stopSequences',
  'seed',
  'reasoning',
] as const;

export type GenerationHyperparameter = (typeof GENERATION_HYPERPARAMETERS)[number];

/** What the RESOLVED provider configuration says it can do. Supplied by the caller — the
 *  applications layer reads it off the `AiRuntimeProfile` / `AiModel` row the node's
 *  `providerConfigRef` selected. */
export interface ProviderGenerationCapabilities {
  /** The hyper-parameters this configuration accepts. `undefined` means the configuration has
   *  declared NOTHING, which is "unknown" and not "unsupported" — see the severity split. */
  readonly supportedGenerationParams?: readonly string[];
  /** How to name the configuration in a message. Without it an author gets a problem they
   *  cannot act on. */
  readonly label?: string;
}

export interface HyperparameterCapabilityProblem {
  readonly parameter: string;
  readonly severity: 'ERROR' | 'WARNING';
  readonly message: string;
}

/**
 * Step 3's rule: *"not every provider accepts them, and silently dropping a parameter the user
 * set is worse than refusing it."*
 *
 * The severity split is the part worth arguing about, so it is stated rather than assumed:
 *
 *  - **capability set DECLARED and the parameter is absent from it ⇒ ERROR.** The platform knows
 *    the parameter will be ignored. Publishing anyway means shipping a graph whose author
 *    believes they tuned something they did not, which is exactly the silent drop.
 *  - **capability set ABSENT ⇒ WARNING.** "Nobody has profiled this configuration" is not
 *    evidence of non-support, and refusing every graph bound to an unprofiled configuration would
 *    block the platform on data entry rather than on a real conflict. The author is told the
 *    parameter is unverified.
 *
 * This is NOT the `failMode: closed` rule being relaxed. That rule governs SELECTION (which
 * provider, which model) — an unresolved selection still raises and substitutes nothing. These
 * are tuning knobs, whose declared posture is `open-to-default`
 * (`09-infrastructure-devops.md` §Configuration Tiers).
 */
export function hyperparameterCapabilityProblems(
  generation: Readonly<Record<string, unknown>> | undefined,
  capabilities: ProviderGenerationCapabilities | undefined,
): HyperparameterCapabilityProblem[] {
  if (generation === undefined) return [];
  const set = Object.keys(generation).filter((key) => generation[key] !== undefined);
  if (set.length === 0) return [];

  const where = capabilities?.label !== undefined ? `the bound provider configuration \`${capabilities.label}\`` : 'the bound provider configuration';
  const supported = capabilities?.supportedGenerationParams;

  if (supported === undefined) {
    return set.map((parameter) => ({
      parameter,
      severity: 'WARNING' as const,
      message: `\`generation.${parameter}\` cannot be verified: ${where} declares no supported-parameter set, so the platform cannot tell whether this value will be honoured or ignored.`,
    }));
  }

  const declared = new Set(supported);
  return set
    .filter((parameter) => !declared.has(parameter))
    .map((parameter) => ({
      parameter,
      severity: 'ERROR' as const,
      message: `\`generation.${parameter}\` is not supported by ${where}. It would be dropped on the wire rather than applied — refused here instead, because a silently ignored generation parameter is indistinguishable from one that worked.`,
    }));
}

// =============================================================================================
// Per-node structural checks (steps 5 and 6)
// =============================================================================================

/** The slice of the graph a node-level check needs. Both fields optional: a caller checking a
 *  single node in isolation (the Studio inspector, before the node is wired) still gets the
 *  within-node rules, and only the cross-node ones are skipped. */
export interface AgenticGraphContext {
  readonly nodeIds?: readonly string[];
  /** `nodeId -> node type`, so a guard reference can be checked for being a GUARD and not merely
   *  for existing. */
  readonly nodeTypesById?: Readonly<Record<string, string>>;
}

export interface AgenticNodeView {
  readonly id: string;
  readonly type: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Node types whose `classes` include `guard`, as a literal set. Duplicated here rather than read
 *  from `classesOf()` for the same reason `MANDATORY_NODE_TYPES` is duplicated in
 *  `node-config-schemas.ts`: `node-registry.ts` imports the schema module, so reading the
 *  registry from a module the registry depends on would close an import cycle. The parity between
 *  this set and the registry's `guard` class is asserted in `agentic-catalogue.task847.test.ts`. */
const GUARD_NODE_TYPES: ReadonlySet<string> = new Set([
  'guard.phi',
  'guard.moderation',
  'guard.groundedness',
  'guardrail.check',
  'agentic.guardrail',
]);

/** Exported for the drift test ONLY — `agentic-catalogue.task847.test.ts` asserts this set is the
 *  registry's own `guard` class plus the one explicitly-named summarization guard. A duplicated
 *  set with no test against its source is just a copy waiting to go stale. */
export const GUARD_NODE_TYPES_FOR_TEST: ReadonlySet<string> = GUARD_NODE_TYPES;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Enforce "EXACTLY ONE of these keys is present".
 *
 * Both failure directions are real and different: BOTH present means the graph names two
 * configurations and the runtime would have to pick, which is a coin flip an author did not
 * intend; NEITHER present means nothing resolves, and provider selection is `failMode: closed`,
 * so the run would fail at dispatch rather than at publish — the worst possible moment to learn
 * about it.
 */
function exactlyOneOf(nodeId: string, field: string, binding: Record<string, unknown> | undefined, keys: readonly string[]): string[] {
  if (binding === undefined) return [];
  const present = keys.filter((key) => binding[key] !== undefined && binding[key] !== null && binding[key] !== '');
  if (present.length === 1) return [];
  const listed = keys.map((key) => `\`${key}\``).join(' / ');
  const found = present.length === 0 ? 'neither' : present.map((key) => `\`${key}\``).join(' + ');
  return [
    `node \`${nodeId}\`: \`${field}\` must carry exactly one of ${listed} — found ${found}. Selection fails closed; an ambiguous or empty binding resolves to nothing at dispatch.`,
  ];
}

function nodeReferenceProblems(
  nodeId: string,
  field: string,
  references: readonly string[],
  context: AgenticGraphContext | undefined,
  options?: { readonly mustBeGuard?: boolean; readonly mayBeSelf?: boolean },
): string[] {
  const problems: string[] = [];
  for (const reference of references) {
    if (!(options?.mayBeSelf ?? false) && reference === nodeId) {
      problems.push(`node \`${nodeId}\`: \`${field}\` names the node itself.`);
      continue;
    }
    if (context?.nodeIds !== undefined && !context.nodeIds.includes(reference)) {
      problems.push(`node \`${nodeId}\`: \`${field}\` names \`${reference}\`, which is not a node in this graph.`);
      continue;
    }
    if ((options?.mustBeGuard ?? false) && context?.nodeTypesById !== undefined) {
      const referencedType = context.nodeTypesById[reference];
      if (referencedType !== undefined && !GUARD_NODE_TYPES.has(referencedType)) {
        problems.push(`node \`${nodeId}\`: \`${field}\` names \`${reference}\`, which is a \`${referencedType}\` and not a guardrail node.`);
      }
    }
  }
  return problems;
}

/**
 * Publish-blocking problems for one `agentic.*` node.
 *
 * A no-op for every other node type, deliberately. This is not a second validator for the
 * pipeline palettes — those are governed by `rule-catalogue.ts`, and a rule with two enforcement
 * paths is a rule whose two paths drift.
 */
export function agenticNodeConfigProblems(node: AgenticNodeView, context?: AgenticGraphContext): string[] {
  if (!node.type.startsWith('agentic.')) return [];
  const config = node.config ?? {};
  const problems: string[] = [];

  if (node.type === 'agentic.agent' || node.type === 'agentic.tts') {
    problems.push(...exactlyOneOf(node.id, 'providerConfigRef', asObject(config.providerConfigRef), ['routingPolicyId', 'taskKey']));
  }

  if (node.type === 'agentic.stt') {
    problems.push(...exactlyOneOf(node.id, 'pipelineRef', asObject(config.pipelineRef), ['pipelineId', 'pipelineSlug']));
  }

  if (node.type === 'agentic.agent') {
    const guards = asObject(config.guards);
    if (guards !== undefined) {
      problems.push(...nodeReferenceProblems(node.id, 'guards.input', asStringArray(guards.input), context, { mustBeGuard: true }));
      problems.push(...nodeReferenceProblems(node.id, 'guards.output', asStringArray(guards.output), context, { mustBeGuard: true }));
    }
  }

  if (node.type === 'agentic.loop') {
    const bounds = asObject(config.bounds);
    // The cost ceiling is checked HERE as well as being `required` in the schema, and that is not
    // redundant: the schema governs what may be AUTHORED, this governs what may be PUBLISHED, and
    // a definition saved before this ticket (or assembled by an importer) reaches publish without
    // ever passing through the schema. Fifty iterations of a large model is an unbounded invoice
    // that completes successfully and looks like a healthy run.
    for (const bound of ['maxIterations', 'maxDurationSeconds', 'maxTotalTokens'] as const) {
      if (bounds === undefined || typeof bounds[bound] !== 'number') {
        problems.push(
          `node \`${node.id}\`: \`bounds.${bound}\` is required. A loop bounded on fewer than all three axes is unbounded on the one that is missing — and \`maxTotalTokens\` is the only one of the three that bounds COST.`,
        );
      }
    }
    const orchestrator = config.orchestratorNodeId;
    if (typeof orchestrator === 'string') {
      problems.push(...nodeReferenceProblems(node.id, 'orchestratorNodeId', [orchestrator], context));
    }
    problems.push(...nodeReferenceProblems(node.id, 'subAgentNodeIds', asStringArray(config.subAgentNodeIds), context));
  }

  return problems;
}
