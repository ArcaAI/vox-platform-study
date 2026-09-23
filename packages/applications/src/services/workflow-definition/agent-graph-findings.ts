import { PUBLISH_FINDING_RULE_ID } from '@arcaai/workflow-contract';
import type { WorkflowFinding, WorkflowGraph } from '@arcaai/workflow-contract';

/**
 * TASK-1002 (OD-2, OD-5) — two publish-gate rules that need to know what each `core.agent` node's
 * agent IS, which `publishFindings` (a pure package with no database) cannot know. The service
 * resolves the agents and hands them in; these functions stay pure.
 *
 * Both are ERROR. Both are reported beside the contract's own publish findings, so `validate()`
 * records them and `publish()` refuses on them through the same `hasBlockingFindings` gate.
 */

export const MULTIPLE_SPEECH_TO_TEXT_AGENTS = 'MULTIPLE_SPEECH_TO_TEXT_AGENTS';
export const OUTPUT_FIELDS_UNREACHABLE = 'OUTPUT_FIELDS_UNREACHABLE';

const SPEECH_TO_TEXT = 'SPEECH_TO_TEXT';

/**
 * What a speech-to-text node hands downstream. Fixed by the runtime, not by the agent: the union
 * of what the realtime `core.agent` handler's `transcribe` branch and the durable harness ASR
 * branch emit, so an output requiring any of them is never refused. No ASR agent declares an
 * output schema that could change them.
 */
export const SPEECH_TO_TEXT_OUTPUT_FIELDS: readonly string[] = Object.freeze([
  'transcript',
  'segments',
  'audio',
  'language',
  'data',
  'pipelineId',
  'jobId',
  'agent',
]);

/** What the service resolved about the agent ONE `core.agent` node runs. */
export interface GraphAgentFacts {
  readonly slug: string;
  readonly task: string | null;
  readonly outputSchema: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const list = (keys: readonly string[]): string => keys.map((key) => `\`${key}\``).join(', ');

/** The agent slug a `core.agent` node names, or `null`. */
export function agentSlugOf(config: unknown): string | null {
  const agentRef = isPlainObject(config) ? config.agentRef : undefined;
  const slug = isPlainObject(agentRef) ? agentRef.slug : undefined;
  return typeof slug === 'string' && slug.length > 0 ? slug : null;
}

/**
 * The `core.agent` node ids either rule could act on — so the service reads an agent row only
 * when the answer can matter: every agent node once the graph has two or more (rule A), and the
 * agent nodes that feed a `core.output` declaring required keys (rule B).
 */
export function agentNodesNeedingFacts(graph: WorkflowGraph): string[] {
  const nodes = (graph.nodes ?? []).filter((node) => typeof node?.id === 'string' && typeof node?.type === 'string');
  const agentIds = new Set(nodes.filter((node) => node.type === 'core.agent').map((node) => node.id));
  if (agentIds.size >= 2) return [...agentIds];

  const needed = new Set<string>();
  for (const output of nodes) {
    if (output.type !== 'core.output' || requiredKeysOf(output.config).length === 0) continue;
    for (const e of graph.edges ?? []) {
      if (e?.to === output.id && agentIds.has(e.from)) needed.add(e.from);
    }
  }
  return [...needed];
}

function requiredKeysOf(config: unknown): string[] {
  const schema = isPlainObject(config) ? config.outputSchema : undefined;
  return isPlainObject(schema) && Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * Both rules, over one graph. `agents` is keyed by NODE id (two nodes may pin two versions of one
 * slug); a node absent from it is unresolved, and an unresolved node is never the cause of a
 * finding — the contract's `AGENT_REF_MISSING` already speaks for a node that names nothing.
 */
export function agentGraphFindings(graph: WorkflowGraph, agents: Readonly<Record<string, GraphAgentFacts>>): WorkflowFinding[] {
  const nodes = (graph.nodes ?? []).filter((node) => typeof node?.id === 'string' && typeof node?.type === 'string');
  return [...multipleSpeechToTextFindings(nodes, agents), ...unreachableOutputFindings(graph, nodes, agents)];
}

// ---------------------------------------------------------------------------------------------
// Rule A (OD-2) — one speech-to-text agent per graph
// ---------------------------------------------------------------------------------------------

function multipleSpeechToTextFindings(nodes: WorkflowGraph['nodes'], agents: Readonly<Record<string, GraphAgentFacts>>): WorkflowFinding[] {
  const asr = nodes.filter((node) => node.type === 'core.agent' && agents[node.id]?.task === SPEECH_TO_TEXT);
  if (asr.length <= 1) return [];
  const named = asr.map((node) => `\`${node.id}\` (\`${agents[node.id]!.slug}\`)`).join(', ');
  return [
    {
      ruleId: PUBLISH_FINDING_RULE_ID,
      ruleClass: 'invariant',
      severity: 'ERROR',
      nodeId: null,
      code: MULTIPLE_SPEECH_TO_TEXT_AGENTS,
      message:
        `This workflow has ${asr.length} speech-to-text agent nodes: ${named}. ` +
        'A consultation is transcribed by one speech-to-text agent, so a workflow may contain only one. Remove all but one of them.',
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Rule B (OD-5) — a `core.output` must be fed the fields it requires
// ---------------------------------------------------------------------------------------------

/** What a node hands downstream: a known field list, or `null` when the shape is unknown. */
function producedFields(facts: GraphAgentFacts | undefined): readonly string[] | null {
  if (!facts) return null;
  if (facts.task === SPEECH_TO_TEXT) return SPEECH_TO_TEXT_OUTPUT_FIELDS;
  const properties = isPlainObject(facts.outputSchema) ? facts.outputSchema.properties : undefined;
  return isPlainObject(properties) ? Object.keys(properties) : null;
}

function describeFeeder(nodeId: string, facts: GraphAgentFacts, produced: readonly string[]): string {
  const fields = produced.length > 0 ? produced.join(', ') : 'no fields';
  // The ASR message names what an admin recognises (a transcript); the accepted field list also
  // carries runtime metadata (`pipelineId`, `jobId`, …) that would only confuse the fix hint.
  return facts.task === SPEECH_TO_TEXT
    ? `\`${nodeId}\`, a speech-to-text agent (\`${facts.slug}\`) that produces only transcript, segments, audio`
    : `\`${nodeId}\`, agent \`${facts.slug}\`, whose output schema declares only ${fields}`;
}

function unreachableOutputFindings(
  graph: WorkflowGraph,
  nodes: WorkflowGraph['nodes'],
  agents: Readonly<Record<string, GraphAgentFacts>>,
): WorkflowFinding[] {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const findings: WorkflowFinding[] = [];

  for (const output of nodes) {
    if (output.type !== 'core.output') continue;
    const required = requiredKeysOf(output.config);
    if (required.length === 0) continue;

    // `after` is an ordering port; it carries no result (`_output_payload` in the harness skips it).
    const feeders = [...new Set((graph.edges ?? []).filter((e) => e?.to === output.id && e.toPort !== 'after').map((e) => e.from))];
    if (feeders.length === 0) continue;

    // Every feeder must have a KNOWN shape; one unknown feeder could supply anything.
    const known: Array<{ nodeId: string; facts: GraphAgentFacts; produced: readonly string[] }> = [];
    for (const nodeId of feeders) {
      const facts = typeById.get(nodeId) === 'core.agent' ? agents[nodeId] : undefined;
      const produced = producedFields(facts);
      if (!facts || produced === null) break;
      known.push({ nodeId, facts, produced });
    }
    if (known.length !== feeders.length) continue;

    const missing = required.filter((key) => !known.some((feeder) => feeder.produced.includes(key)));
    if (missing.length === 0) continue;

    const anyAsr = known.some((feeder) => feeder.facts.task === SPEECH_TO_TEXT);
    const fix = anyAsr
      ? `Add an agent that writes ${list(missing)} (for example a text-generation summary agent) between them.`
      : `Add ${list(missing)} to that agent's output schema, or add an agent that writes ${missing.length === 1 ? 'it' : 'them'} between them.`;
    findings.push({
      ruleId: PUBLISH_FINDING_RULE_ID,
      ruleClass: 'schema',
      severity: 'ERROR',
      nodeId: output.id,
      path: '/outputSchema/required',
      code: OUTPUT_FIELDS_UNREACHABLE,
      message:
        `Output \`${output.id}\` requires ${list(missing)}, but its input comes from ` +
        `${known.map((feeder) => describeFeeder(feeder.nodeId, feeder.facts, feeder.produced)).join('; and ')}. ${fix}`,
    });
  }
  return findings;
}
