import { boundTemplateRefs } from '@arcaai/workflow-contract';
import type { WorkflowFinding, WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';
import { PROMPT_TEMPLATE_ID_KEY, PROMPT_VERSION_NUMBER_KEY } from './node-prompt-binding';

/**
 * TASK-1036 W3 (§8.5) — what a workflow PUBLISH freezes.
 *
 * | Reference | At workflow publish |
 * |---|---|
 * | Agent, in a `core.agent` node | `agentRef.versionNumber` frozen: an authored pin is kept, an absent one is the ACTIVE version now |
 * | The agent version's own prompt | carried by the pinned agent version; recorded in `policyBindings.promptTemplateRefs` |
 * | A workflow-level `promptTemplateId` (node, `core.action` delegate, grounding policy) | frozen to the template's APPROVED version when unpinned |
 * | Document template, DNA | NOT pinned — latest approved / latest report at run time. A node-level `documentVersionNumber` is a deprecated override |
 *
 * The functions here are PURE: the service resolves the facts (repository reads) and these apply
 * them to a COPY of the graph. The authored graph is never rewritten — a published row's `graph` is
 * what the author saved; only the compiled artifact carries what publish resolved.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** One `core.agent` node's reference, as authored. */
export interface AgentNodeRef {
  nodeId: string;
  slug: string;
  /** The authored pin, or `null` = "the active version, captured at publish". */
  versionNumber: number | null;
}

/** Every `core.agent` node that names an agent slug, in authored order. */
export function agentNodeRefs(graph: WorkflowGraph): AgentNodeRef[] {
  const refs: AgentNodeRef[] = [];
  for (const node of graph.nodes ?? []) {
    if (node?.type !== 'core.agent') continue;
    const agentRef = isPlainObject(node.config) && isPlainObject(node.config.agentRef) ? node.config.agentRef : undefined;
    const slug = agentRef?.slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    refs.push({ nodeId: node.id, slug, versionNumber: positiveInteger(agentRef?.versionNumber) ? agentRef.versionNumber : null });
  }
  return refs;
}

/** What publish resolved for one agent node. */
export interface ResolvedAgentPin {
  versionNumber: number;
  /** The prompt template(s) that agent VERSION runs, each at the version it froze. */
  promptRefs: Array<{ templateId: string; versionNumber: number }>;
}

/**
 * The prompt pins an agent VERSION carries: its instruction's bound templates, each at the
 * instruction's own pin, else at the version the agent's compiled prompt froze at ITS publish
 * (`compiledConfig.resolvedPrompt`). A template with neither is not reported — there is nothing
 * frozen to report, and inventing a version would be worse.
 */
export function agentPromptPins(instruction: unknown, compiledConfig: unknown): Array<{ templateId: string; versionNumber: number }> {
  const resolvedPrompt = isPlainObject(compiledConfig) && isPlainObject(compiledConfig.resolvedPrompt) ? compiledConfig.resolvedPrompt : undefined;
  const frozenTemplateId = typeof resolvedPrompt?.promptTemplateId === 'string' ? resolvedPrompt.promptTemplateId : null;
  const frozenVersion = positiveInteger(resolvedPrompt?.promptVersionNumber) ? resolvedPrompt.promptVersionNumber : null;
  const pins: Array<{ templateId: string; versionNumber: number }> = [];
  for (const ref of boundTemplateRefs(instruction)) {
    const versionNumber = ref.versionNumber ?? (ref.templateId === frozenTemplateId ? frozenVersion : null);
    if (versionNumber !== null) pins.push({ templateId: ref.templateId, versionNumber });
  }
  return pins;
}

/** A copy of `graph` with each resolved agent node's `agentRef.versionNumber` set. */
export function pinAgentNodes(graph: WorkflowGraph, pins: ReadonlyMap<string, ResolvedAgentPin>): WorkflowGraph {
  if (pins.size === 0) return graph;
  return {
    ...graph,
    nodes: (graph.nodes ?? []).map((node) => {
      const pin = pins.get(node.id);
      if (node.type !== 'core.agent' || pin === undefined || !isPlainObject(node.config) || !isPlainObject(node.config.agentRef)) return node;
      return { ...node, config: { ...node.config, agentRef: { ...node.config.agentRef, versionNumber: pin.versionNumber } } };
    }),
  };
}

/** Every UNPINNED `promptTemplateId` the graph carries, wherever it sits (node, delegate, policies). */
export function unpinnedPromptTemplateIds(graph: WorkflowGraph): string[] {
  const ids = new Set<string>();
  const visit = (holder: Record<string, unknown>): void => {
    const id = holder[PROMPT_TEMPLATE_ID_KEY];
    if (typeof id === 'string' && id.length > 0 && !positiveInteger(holder[PROMPT_VERSION_NUMBER_KEY])) ids.add(id);
  };
  for (const node of graph.nodes ?? []) forEachPromptHolder(node, visit);
  return [...ids];
}

/**
 * Where a node carries a prompt binding: its own config, its `core.action` delegate
 * (`config.action`, TASK-893), and each entry of a grounding guard's `policies[]`.
 */
function forEachPromptHolder(node: WorkflowGraphNode, visit: (holder: Record<string, unknown>) => void): void {
  if (!isPlainObject(node.config)) return;
  visit(node.config);
  if (isPlainObject(node.config.action)) visit(node.config.action);
  if (Array.isArray(node.config.policies)) for (const policy of node.config.policies) if (isPlainObject(policy)) visit(policy);
}

/**
 * A copy of `graph` with every UNPINNED prompt binding pinned to the version `approved` names for
 * its template. A template `approved` does not name (never approved, unreadable) stays unpinned —
 * it follows the approved version at run time, exactly as it did before publish froze anything.
 */
export function pinPromptBindings(graph: WorkflowGraph, approved: ReadonlyMap<string, number>): { graph: WorkflowGraph; pinned: number } {
  let pinned = 0;
  const pinHolder = (holder: Record<string, unknown>): Record<string, unknown> => {
    const id = holder[PROMPT_TEMPLATE_ID_KEY];
    if (typeof id !== 'string' || positiveInteger(holder[PROMPT_VERSION_NUMBER_KEY])) return holder;
    const version = approved.get(id);
    if (version === undefined) return holder;
    pinned += 1;
    return { ...holder, [PROMPT_VERSION_NUMBER_KEY]: version };
  };
  const nodes = (graph.nodes ?? []).map((node) => {
    if (!isPlainObject(node.config)) return node;
    let config = pinHolder(node.config);
    if (isPlainObject(config.action)) config = { ...config, action: pinHolder(config.action) };
    if (Array.isArray(config.policies)) {
      config = { ...config, policies: config.policies.map((policy) => (isPlainObject(policy) ? pinHolder(policy) : policy)) };
    }
    return config === node.config ? node : { ...node, config };
  });
  return { graph: pinned === 0 ? graph : { ...graph, nodes }, pinned };
}

/** The machine-readable code of a node that still pins a document template version. */
export const DOCUMENT_VERSION_PIN_DEPRECATED = 'DOCUMENT_VERSION_PIN_DEPRECATED';
/** The machine-readable code of an agent node publish could not freeze. */
export const AGENT_PIN_UNRESOLVED = 'AGENT_PIN_UNRESOLVED';
/** TASK-1038 E2 (fix 9, OD-21) — an explicit pin on a DEPRECATED agent version: kept, with a warning. */
export const AGENT_PIN_DEPRECATED = 'AGENT_PIN_DEPRECATED';

/**
 * W3 — a document template follows its latest APPROVED version (OD-22). A node that still names a
 * `documentVersionNumber` keeps it, as an override, for one release; this is the WARNING that says
 * so. Never blocks.
 */
export function documentPinFindings(graph: WorkflowGraph): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const node of graph.nodes ?? []) {
    const config = isPlainObject(node?.config) ? node.config : undefined;
    if (config === undefined || !positiveInteger(config.documentVersionNumber)) continue;
    findings.push({
      ruleId: 'WF-PIN-001',
      ruleClass: 'schema',
      severity: 'WARNING',
      nodeId: node.id,
      path: '/documentVersionNumber',
      code: DOCUMENT_VERSION_PIN_DEPRECATED,
      message: `Step \`${node.id}\` pins document template version ${config.documentVersionNumber}. Document templates now follow their latest approved version; the pin is honoured as an override for one release — remove it.`,
    });
  }
  return findings;
}

/** The blocking finding for an agent node whose version publish could not resolve. */
export function agentPinUnresolvedFinding(ref: AgentNodeRef): WorkflowFinding {
  return {
    ruleId: 'WF-PIN-002',
    ruleClass: 'schema',
    severity: 'ERROR',
    nodeId: ref.nodeId,
    path: '/agentRef',
    code: AGENT_PIN_UNRESOLVED,
    message:
      ref.versionNumber === null
        ? `Step \`${ref.nodeId}\` uses agent \`${ref.slug}\`, which has no active published version to pin. Publish the agent first.`
        : `Step \`${ref.nodeId}\` pins agent \`${ref.slug}\` version ${ref.versionNumber}, which is not a published version of this tenant.`,
  };
}

/**
 * TASK-1038 E2 (fix 9, OD-21) — an authored `agentRef.versionNumber` that names a DEPRECATED
 * version publishes: a pinned version keeps running after it is deprecated (the runtime resolver
 * serves PUBLISHED and DEPRECATED pins), so refusing the publish would contradict the runtime.
 * The author is told, never blocked.
 */
export function agentPinDeprecatedFinding(ref: AgentNodeRef & { versionNumber: number }): WorkflowFinding {
  return {
    ruleId: 'WF-PIN-003',
    ruleClass: 'schema',
    severity: 'WARNING',
    nodeId: ref.nodeId,
    path: '/agentRef',
    code: AGENT_PIN_DEPRECATED,
    message: `Step \`${ref.nodeId}\` pins agent \`${ref.slug}\` version ${ref.versionNumber}, which is deprecated. It keeps running; pin a published version to pick up the agent's current behaviour.`,
  };
}
