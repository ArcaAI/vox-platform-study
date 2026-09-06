/**
 * TASK-890 §3.5 (F-10) — the ONE publish gate for a workflow graph, as machine-readable findings.
 *
 * ## What this replaces, and why
 *
 * `workflowPublishProblems` (deleted with this module) was a real gate that NOTHING called
 * (BLOCKER 1c). It also returned `string[]`, which the Studio cannot map onto a canvas node and a
 * console cannot offer a fix for. `publishFindings` re-emits every one of its checks as a
 * `WorkflowFinding` with a `code`, and adds the check nobody ran at all — the per-node config
 * SCHEMA (`NODE_CONFIG_SCHEMA`). A definition that arrived through an importer, or that predates
 * a schema change, now meets the same gate as one authored in the Studio.
 *
 * ## The one enforcement point
 *
 * `WorkflowDefinitionService.publishEntity` calls this after the shape check and before compile,
 * records every finding on `validationReport.findings` and refuses on `hasBlockingFindings`;
 * `validate()` calls it and records WITHOUT refusing. There is no second validator, and nothing
 * decides publishability anywhere else.
 *
 * ## Scope of the NEW checks, in release 1
 *
 * The schema, template, override-range and context-schema checks run on `core.*` nodes only
 * (Risk 4): the legacy palettes' seeded graphs predate their own schemas, and enforcing them on
 * day one would make every saved definition unpublishable — the exact retroactive-invalidation
 * trap `port-validation.ts` documents for typed ports. Everything `workflowPublishProblems`
 * already ran — the port lattice, the descriptor contract, `requires[]` guard attachment, the
 * loop-body rules and the `agentic.*` reference checks — still runs over the WHOLE graph, so
 * deleting the old export removed an unused API and no coverage.
 *
 * ## Why the schema checker is injected
 *
 * This package has zero runtime dependencies, so it cannot import
 * `@arcaai/json-schema-subset`. `schemaValueProblems` is therefore a REQUIRED field of
 * `PublishContext` rather than an optional one: a required field cannot be forgotten, which is
 * precisely how the gate this module replaces came to be unwired.
 */
import { agenticNodeConfigProblems } from './agentic-contract';
import type { AgenticGraphContext } from './agentic-contract';
import { coreNodeConfigProblems, loopBodyProblems } from './core-contract';
import type { WorkflowGraph, WorkflowGraphNode } from './graph-model';
import { guardrailOptOutOf, resolveGuardrailDecision } from './guardrail-optout';
import { NODE_CONFIG_SCHEMAS } from './node-config-schemas';
import type { WorkflowNodeDescriptor } from './node-registry';
import { WORKFLOW_NODE_REGISTRY } from './node-registry';
import { nodeDescriptorContractProblems, workflowEdgePortProblems } from './port-validation';
import type { WorkflowFinding, WorkflowFindingSeverity, WorkflowRuleClass } from './report';
import { templateReferenceProblems, templateSyntaxProblems } from './template';
import type { DeclaredNamespaces } from './template';

// =============================================================================================
// The code vocabulary (§3.5) — shared with `AgentFindingCode` in the applications layer
// =============================================================================================

export const WORKFLOW_PUBLISH_FINDING_CODES = Object.freeze([
  'NODE_CONFIG_SCHEMA',
  'AGENT_REF_MISSING',
  'CEL_INVALID',
  'BRANCH_HANDLE',
  'LOOP_BOUNDS',
  'OUTPUT_PROTOCOL',
  'ACTION_KEY',
  'LOOP_BODY',
  'PORT_BINDING',
  'NODE_CONTRACT',
  'GUARD_REQUIRED',
  'OVERRIDE_OUT_OF_RANGE',
  'CONTEXT_SCHEMA_NOT_FOUND',
  'CONTEXT_SCHEMA_VERSION_NOT_FOUND',
  'PROMPT_VARIABLE_UNDECLARED',
  'PROMPT_TEMPLATE_SYNTAX',
  'GUARDRAIL_OPTED_OUT',
] as const);
export type WorkflowPublishFindingCode = (typeof WORKFLOW_PUBLISH_FINDING_CODES)[number];

/**
 * Every finding from this gate carries the SAME `ruleId`, because a publish finding is not a
 * rule-catalogue rule: the catalogue's ids identify clinician-reviewable POLICY, and stamping
 * these with ids from that space would make the DRAFT rule set look larger and more reviewed than
 * it is. The specificity lives on `code`, which is the axis a console actually branches on.
 */
export const PUBLISH_FINDING_RULE_ID = 'WF-PUB';

/**
 * The OD-C ramp (P-4), as ONE constant. `PROMPT_VARIABLE_UNDECLARED` is a WARNING in the first
 * release and an ERROR in the next, and the promotion is meant to be a one-line, reviewable diff
 * rather than a hunt through call sites — so every caller in this monorepo passes THIS, and the
 * release that decides to enforce it changes this value alone.
 *
 * It is a WARNING today because the check is new and the corpus is not: an agent whose prompt
 * references a context schema no tenant has bound yet (gap 4e) would otherwise become
 * unpublishable the moment this shipped, which is a migration disguised as a gate.
 */
export const TEMPLATE_REFERENCE_SEVERITY_RELEASE_1: WorkflowFindingSeverity = 'WARNING';

// =============================================================================================
// Context
// =============================================================================================

/** A JSON Schema, as this package models one everywhere else: an opaque plain object. */
type SchemaLike = Readonly<Record<string, unknown>>;

/** A bound the agent declares for one generation hyper-parameter. Absent halves are unbounded. */
export interface GenerationRange {
  readonly min?: number;
  readonly max?: number;
}

export type GenerationRanges = Readonly<Record<string, GenerationRange>>;

/** What the caller resolved about ONE agent a `core.agent` node references, by slug. */
export interface PublishAgentView {
  /** The agent's `instruction.variables` names plus its template's own declarations. */
  readonly declaredVariables: readonly string[];
  /** The derived payload schema of the agent's bound context schema; `null` when it binds none. */
  readonly contextPayloadSchema: SchemaLike | null;
  /** Per-hyper-parameter bounds a node override must sit inside (4c). Absent = unchecked. */
  readonly generationRanges?: GenerationRanges;
}

export interface PublishContext {
  /** A caller may overlay descriptors (a tenant's pinned registry, a synthetic type under test). */
  readonly registry?: Readonly<Record<string, WorkflowNodeDescriptor>>;
  /** Per referenced agent slug, resolved by the caller (the service) — this package has no DB. */
  readonly agents?: Readonly<Record<string, PublishAgentView>>;
  /**
   * The trigger's resolved context payload schema. `undefined` = the caller did not resolve the
   * reference (no finding); `null` = it resolved to NOTHING, which is a finding.
   */
  readonly triggerContextSchema?: SchemaLike | null;
  /** Which failure `triggerContextSchema: null` was. Defaults to `CONTEXT_SCHEMA_NOT_FOUND`. */
  readonly triggerContextSchemaFailure?: 'CONTEXT_SCHEMA_NOT_FOUND' | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND';
  /**
   * The OD-C ramp: `'WARNING'` in the first release, `'ERROR'` in the next (P-4). The CALLER
   * owns it because the same undeclared variable is authoring feedback in a draft and a publish
   * refusal a release later — a severity that changes with the rollout is not a property of a
   * pure function.
   */
  readonly templateReferenceSeverity: WorkflowFindingSeverity;
  /**
   * `jsonSchemaValueProblems` from `@arcaai/json-schema-subset`. Injected, not imported: this
   * package has zero runtime dependencies. REQUIRED so the gate cannot be silently skipped.
   */
  readonly schemaValueProblems: (schema: unknown, value: unknown, path?: string) => string[];
}

// =============================================================================================
// Helpers
// =============================================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finding(
  code: WorkflowPublishFindingCode,
  ruleClass: WorkflowRuleClass,
  severity: WorkflowFindingSeverity,
  nodeId: string | null,
  message: string,
  path?: string,
): WorkflowFinding {
  return { ruleId: PUBLISH_FINDING_RULE_ID, ruleClass, severity, nodeId, code, message, ...(path === undefined ? {} : { path }) };
}

/**
 * Which code a `coreNodeConfigProblems` string carries. Classified by NODE TYPE rather than by
 * matching prose, so a reworded message cannot silently re-file itself under another code; the
 * two types that run two different checks (`core.condition`, `core.loop`) are split on the field
 * name the message quotes, which is part of the check's own contract.
 */
function coreProblemCode(nodeType: string, message: string): WorkflowPublishFindingCode {
  switch (nodeType) {
    case 'core.agent':
      return 'AGENT_REF_MISSING';
    case 'core.classify':
      return 'BRANCH_HANDLE';
    case 'core.condition':
      return message.includes('`branches[') ? 'CEL_INVALID' : 'BRANCH_HANDLE';
    case 'core.loop':
      return message.includes('`until`') ? 'CEL_INVALID' : 'LOOP_BOUNDS';
    case 'core.output':
      return 'OUTPUT_PROTOCOL';
    case 'core.action':
      return 'ACTION_KEY';
    default:
      return 'NODE_CONFIG_SCHEMA';
  }
}

/** `vars.*` for this graph: every key declared by a `core.variable` node. */
function declaredVarKeys(nodes: readonly WorkflowGraphNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node?.type !== 'core.variable') continue;
    const declared = isPlainObject(node.config) ? node.config.variables : undefined;
    for (const entry of Array.isArray(declared) ? declared : []) {
      if (isPlainObject(entry) && typeof entry.key === 'string') keys.push(entry.key);
    }
  }
  return keys;
}

/** An object schema over a flat key list — how `vars.*` becomes checkable at all. */
function schemaOfKeys(keys: readonly string[]): SchemaLike {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(keys.map((key) => [key, {}])),
  };
}

// =============================================================================================
// The gate
// =============================================================================================

export function publishFindings(graph: WorkflowGraph, ctx: PublishContext): WorkflowFinding[] {
  const registry = ctx.registry === undefined ? WORKFLOW_NODE_REGISTRY : { ...WORKFLOW_NODE_REGISTRY, ...ctx.registry };
  const findings: WorkflowFinding[] = [];
  const nodes = (graph.nodes ?? []).filter((node): node is WorkflowGraphNode => typeof node?.id === 'string' && typeof node?.type === 'string');
  const edges = graph.edges ?? [];

  // ---------------------------------------------------------------------------------------
  // Inherited: the port lattice. Edge-attributed, so `nodeId` is null by the report's own
  // convention ("a graph-level finding, not attributable to one node").
  // ---------------------------------------------------------------------------------------
  for (const problem of workflowEdgePortProblems(graph, { registry: ctx.registry })) {
    findings.push(finding('PORT_BINDING', 'structural', 'ERROR', null, problem));
  }

  // Inherited: the `agentic.*` cross-node reference checks (exactly-one provider source, the
  // three-axis loop bounds, guard/orchestrator references naming real nodes of the right class).
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const agenticContext: AgenticGraphContext = { nodeIds: [...typeById.keys()], nodeTypesById: Object.fromEntries(typeById) };
  for (const node of nodes) {
    for (const problem of agenticNodeConfigProblems(
      { id: node.id, type: node.type, config: node.config as Record<string, unknown> },
      agenticContext,
    )) {
      findings.push(finding('NODE_CONFIG_SCHEMA', 'schema', 'ERROR', node.id, problem));
    }
  }

  // Inherited: the `core` vocabulary's own publish checks, now coded per check.
  for (const node of nodes) {
    for (const problem of coreNodeConfigProblems({ id: node.id, type: node.type, config: node.config as Record<string, unknown> })) {
      findings.push(finding(coreProblemCode(node.type, problem), 'schema', 'ERROR', node.id, problem));
    }
  }

  // Inherited: loop bodies, graph-wide.
  for (const problem of loopBodyProblems(graph)) {
    findings.push(finding('LOOP_BODY', 'structural', 'ERROR', null, problem));
  }

  // Inherited: the descriptor contract (once per TYPE) and `requires[]` guard attachment (per
  // INSTANCE — two `generate.text` nodes each need their own guard, because a guard wired to one
  // says nothing about the other).
  const seenTypes = new Set<string>();
  for (const node of nodes) {
    const descriptor = registry[node.type];
    if (descriptor === undefined) continue;
    if (!seenTypes.has(node.type)) {
      seenTypes.add(node.type);
      for (const problem of nodeDescriptorContractProblems(descriptor)) {
        findings.push(finding('NODE_CONTRACT', 'structural', 'ERROR', null, problem));
      }
    }
    if (descriptor.requires.length === 0) continue;
    const neighbourTypes = new Set<string>();
    for (const edge of edges) {
      if (edge?.from === node.id) {
        const neighbour = typeById.get(edge.to);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
      if (edge?.to === node.id) {
        const neighbour = typeById.get(edge.from);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
    }
    for (const required of descriptor.requires) {
      if (neighbourTypes.has(required)) continue;
      findings.push(
        finding(
          'GUARD_REQUIRED',
          'invariant',
          'ERROR',
          node.id,
          `node ${JSON.stringify(node.id)} (${node.type}) requires an attached ${JSON.stringify(required)} guard, and none is connected to this instance`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------------------
  // NEW, `core.*` only (release 1 scope).
  // ---------------------------------------------------------------------------------------
  const coreNodes = nodes.filter((node) => node.type.startsWith('core.'));

  // The per-node config SCHEMA — the check nobody ran.
  for (const node of coreNodes) {
    const schema = NODE_CONFIG_SCHEMAS[node.type];
    if (schema === undefined) continue;
    for (const problem of ctx.schemaValueProblems(schema, node.config ?? {}, '')) {
      findings.push(finding('NODE_CONFIG_SCHEMA', 'schema', 'ERROR', node.id, problem));
    }
  }

  // The trigger's context-schema reference, as the caller resolved it.
  if (ctx.triggerContextSchema === null) {
    for (const node of coreNodes) {
      if (node.type !== 'core.trigger') continue;
      const contextSchema = isPlainObject(node.config) ? node.config.contextSchema : undefined;
      const byRef = isPlainObject(contextSchema) && typeof contextSchema.contextSchemaId === 'string' && contextSchema.contextSchemaId.length > 0;
      if (!byRef) continue;
      const code = ctx.triggerContextSchemaFailure ?? 'CONTEXT_SCHEMA_NOT_FOUND';
      findings.push(
        finding(
          code,
          'schema',
          'ERROR',
          node.id,
          code === 'CONTEXT_SCHEMA_VERSION_NOT_FOUND'
            ? `node \`${node.id}\`: the pinned version of context schema \`${String((contextSchema as Record<string, unknown>).contextSchemaId)}\` does not exist in this tenant.`
            : `node \`${node.id}\`: context schema \`${String((contextSchema as Record<string, unknown>).contextSchemaId)}\` is not visible to this tenant. A schema is CLONED into a tenant, never shared from SYSTEM.`,
          '/contextSchema/contextSchemaId',
        ),
      );
    }
  }

  // The workflow's guardrail default, folded per `core.agent` node with the node's own opinion.
  const workflowGuardrail = (() => {
    for (const node of coreNodes) {
      if (node.type !== 'core.trigger') continue;
      const opinion = guardrailOptOutOf(node.config);
      if (opinion !== null) return { opinion, nodeId: node.id };
    }
    return null;
  })();
  if (workflowGuardrail !== null && !workflowGuardrail.opinion) {
    findings.push(
      finding(
        'GUARDRAIL_OPTED_OUT',
        'invariant',
        'WARNING',
        workflowGuardrail.nodeId,
        `This workflow turns platform guardrail screening OFF by default (source: workflow). Every \`core.agent\` node that does not override it runs unscreened, and each run records \`guardrail: "opted_out"\`.`,
        '/guardrail/enabled',
      ),
    );
  }

  const varsSchema = schemaOfKeys(declaredVarKeys(nodes));

  for (const node of coreNodes) {
    if (node.type !== 'core.agent') continue;
    const config = isPlainObject(node.config) ? node.config : {};
    const agentRef = isPlainObject(config.agentRef) ? config.agentRef : undefined;
    const slug = typeof agentRef?.slug === 'string' ? agentRef.slug : null;
    const agent = slug === null ? undefined : ctx.agents?.[slug];
    const overrides = isPlainObject(config.overrides) ? config.overrides : undefined;

    // Guardrail: the FOLD, not the literal — a node inheriting an off workflow default is opted
    // out just as surely as one that says so itself, and the record has to show both.
    const decision = resolveGuardrailDecision({ node: guardrailOptOutOf(config), workflow: workflowGuardrail?.opinion ?? null });
    if (!decision.enabled) {
      findings.push(
        finding(
          'GUARDRAIL_OPTED_OUT',
          'invariant',
          'WARNING',
          node.id,
          `node \`${node.id}\`: platform guardrail screening is OFF for this agent node (source: ${decision.source}). The call runs unscreened and records \`guardrail: "opted_out"\`.`,
          '/guardrail/enabled',
        ),
      );
    }

    // 4c — the per-node override must sit inside the agent's declared range. The node schema
    // already bounds each hyper-parameter globally; this is the AGENT's narrower promise.
    const generation = isPlainObject(overrides?.generation) ? overrides.generation : undefined;
    if (generation !== undefined && agent?.generationRanges !== undefined) {
      for (const [parameter, value] of Object.entries(generation)) {
        const range = agent.generationRanges[parameter];
        if (range === undefined || typeof value !== 'number') continue;
        const below = typeof range.min === 'number' && value < range.min;
        const above = typeof range.max === 'number' && value > range.max;
        if (!below && !above) continue;
        findings.push(
          finding(
            'OVERRIDE_OUT_OF_RANGE',
            'schema',
            'ERROR',
            node.id,
            `node \`${node.id}\`: \`overrides.generation.${parameter}\` is ${value}, outside the range agent \`${slug}\` declares (${range.min ?? '-∞'}..${range.max ?? '∞'}).`,
            `/overrides/generation/${parameter}`,
          ),
        );
      }
    }

    // The templates a GRAPH carries are the per-node prompt-variable overrides: their values
    // interpolate from the run context (`node-config-schemas.ts` says so on the property itself).
    const promptVariables = isPlainObject(overrides?.promptVariables) ? overrides.promptVariables : undefined;
    if (promptVariables === undefined) continue;

    const declared: DeclaredNamespaces = {
      roots: {
        // `context` is the alias of `trigger` when a context schema is bound, so ONE prompt is
        // portable between a workflow run and a standalone invocation (§3.3).
        trigger: ctx.triggerContextSchema ?? null,
        context: ctx.triggerContextSchema ?? agent?.contextPayloadSchema ?? null,
        vars: varsSchema,
        // Upstream node output ports are not resolved in release 1: a wildcard admits them rather
        // than warning on every legitimate `{{nodes.x.y}}`. Narrowing it is a later ramp, like
        // `templateReferenceSeverity` itself.
        nodes: null,
        input: null,
      },
      variables: [...(agent?.declaredVariables ?? []), ...Object.keys(promptVariables)],
    };

    for (const [key, value] of Object.entries(promptVariables)) {
      if (typeof value !== 'string') continue;
      const path = `/overrides/promptVariables/${key}`;
      const syntax = templateSyntaxProblems(value);
      if (syntax.length > 0) {
        for (const problem of syntax) {
          findings.push(finding('PROMPT_TEMPLATE_SYNTAX', 'schema', 'ERROR', node.id, `node \`${node.id}\`: ${problem}`, path));
        }
        // A template that does not parse has no meaningful references to cross-check.
        continue;
      }
      for (const problem of templateReferenceProblems(value, declared)) {
        findings.push(
          finding('PROMPT_VARIABLE_UNDECLARED', 'schema', ctx.templateReferenceSeverity, node.id, `node \`${node.id}\`: ${problem}`, path),
        );
      }
    }
  }

  return findings;
}
