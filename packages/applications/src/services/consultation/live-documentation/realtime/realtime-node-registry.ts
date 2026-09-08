/**
 * The REALTIME node registry: which node instances this runtime can run, and what each does.
 *
 * ## TASK-893 — keyed by what a node IS, never by a legacy type string
 *
 * Until this ticket the handler table was keyed by legacy node types (`consultation.captureBinding`,
 * `consultation.extractEntities`, `consultation.realtimeSummary`, `agent.*`) and a `core.agent`
 * always generated the running note. Those types are gone. A `core.agent` now dispatches on the
 * RESOLVED agent task (INTERFACES §7.4): `SPEECH_TO_TEXT` binds the live transcript,
 * `NAMED_ENTITY_RECOGNITION` extracts entities, `TEXT_GENERATION` generates the running note —
 * applying the agent's declared output schema as a response format (contract N4). A `core.action`
 * runs only when `ACTION_CATALOGUE[key].lane === 'realtime'`; no kept action is, so
 * `REALTIME_ACTION_HANDLERS` is empty and asserted total.
 *
 * A node's OUTCOME carries the CAPABILITY it ran (`RealtimeCapabilityKey`), which is what a
 * projection keys on — never a type string, because every realtime node is now `core.agent`.
 *
 * ## Ports come from `@arcaai/workflow-contract`, never from here
 *
 * Every handler reads its port descriptors out of `NODE_PORTS` / `effectivePorts`. That is what
 * keeps the type check structural: this file cannot widen a socket it does not own.
 */
import {
  ACTION_CATALOGUE,
  NODE_CONFIG_SCHEMAS,
  NODE_PORTS,
  WORKFLOW_NODE_REGISTRY,
  actionDelegateOf,
  effectivePorts,
  type WorkflowNodePorts,
  type WorkflowPortDescriptor,
} from '@arcaai/workflow-contract';
import type { HarnessLiveAssistProposalDto } from '../../harness/dto';
import type { LiveSummaryEntityDto, LiveSummarySectionDto, LiveSummaryStatsDto, LiveSummaryVitalsDto } from '../dto';
import { outputSchemaResponseFormat, type JsonSchemaResponseFormat } from './output-schema-response-format.stub';

/** The wire shape a correction proposal already has on the live-assist plane. */
type LiveAssistProposal = HarnessLiveAssistProposalDto;

/**
 * Node TYPES whose descriptor says `lane: 'realtime'` — DERIVED from the contract. Since TASK-893
 * no registered type is realtime by TYPE (lane is a property of the `core.agent` / `core.action`
 * INSTANCE), so this set is empty; it stays derived so a future realtime-by-type entry is a
 * failing totality test here, never a silent no-op at flush time.
 */
export const REALTIME_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.lane === 'realtime')
    .map((descriptor) => descriptor.key),
);

/**
 * Lane membership is a property of the INSTANCE (TASK-864 A5): `core.agent` / `core.action` carry
 * `execution.lane` in their own config. A `core.action` inherits its catalogue entry's lane when
 * the instance says nothing. The durable interpreter applies the SAME predicate
 * (`_configured_realtime` in `workflow.py`), so exactly one runtime executes any given node.
 */
export function isRealtimeNode(type: string, config?: Readonly<Record<string, unknown>>): boolean {
  if (type === 'core.agent' || type === 'core.action') {
    const execution = config?.execution;
    const lane = typeof execution === 'object' && execution !== null ? (execution as { lane?: unknown }).lane : undefined;
    if (lane === 'realtime') return true;
    if (lane === 'durable') return false;
    if (type === 'core.action') return actionDelegateOf(config)?.lane === 'realtime';
    return false;
  }
  return REALTIME_NODE_TYPES.has(type);
}

// =============================================================================
// Capabilities — the NARROW port the host service implements
// =============================================================================

/** The agent tasks this lane dispatches on. Typed locally so the lane needs no enum from N. */
export type RealtimeAgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

/** The capability a node instance ran — what an outcome is keyed by. */
export type RealtimeCapabilityKey = 'transcribe' | 'extractEntities' | 'generateDocument' | 'proposeCorrections' | 'extractFindings';

export interface TranscribeResult {
  /** The transcript this turn contributes. Raw ASR output — never generated text. */
  transcript: string;
  /** The ASR binding this capture ran on, or null on the tenant's default. */
  pipelineId: string | null;
}

/**
 * A `core.agent` node's reference to the agent it runs. Two forms:
 *  - by SLUG (+ optional version pin) — what a tenant AUTHORS (`agentRef.slug` is required by the
 *    node schema and `coreNodeConfigProblems`);
 *  - by TASK — the tenant's ASSIGNED agent for that task, which only the code-built
 *    {@link PLATFORM_REALTIME_LANE} uses (no slug is hard-coded anywhere; the assignment cascade
 *    decides). A published graph can never carry this form.
 */
export type RealtimeAgentRef = { slug: string; versionNumber?: number; task?: undefined } | { task: RealtimeAgentTask; slug?: undefined };

/** What the host resolved about a referenced agent — the part the lane dispatches on. */
export interface RealtimeResolvedAgentView {
  readonly slug: string;
  readonly task: RealtimeAgentTask;
  /** The agent's declared `outputSchema` (TEXT_GENERATION), applied per contract N4. */
  readonly outputSchema?: unknown;
  /** The agent's `parameters` — an explicit `responseFormat` there always wins. */
  readonly parameters?: Record<string, unknown> | null;
}

export interface GenerateDocumentInput {
  /** The transcript this turn contributes, resolved from the node's declared `in` port. */
  sourceText: string;
  tenantId: string;
  /** The node's OWN authored config — the only thing that distinguishes two instances of one type. */
  config?: Readonly<Record<string, unknown>>;
  /** The node's `agentRef`, which the HOST resolves (explicit slug + pin, fail closed on drift). */
  agentRef?: RealtimeAgentRef;
  /**
   * Contract N4 (TASK-930): the JSON-schema response format derived from the agent's declared
   * `outputSchema`, or `undefined` when the declared output is the task default / not an object
   * schema / overridden by `parameters.responseFormat`. The host forwards it on the text call.
   */
  responseFormat?: JsonSchemaResponseFormat;
}

export interface GenerateDocumentResult {
  text: string;
  sections: LiveSummarySectionDto[];
  stats: LiveSummaryStatsDto | null;
  /** Whether the bounded JSON auto-repair retry ran. */
  repaired: boolean;
}

export interface ExtractEntitiesInput {
  /** The text resolved from the node's declared `in` port. */
  sourceText: string;
  tenantId: string;
}

export interface ExtractEntitiesResult {
  entities: LiveSummaryEntityDto[];
  vitals?: LiveSummaryVitalsDto;
}

export interface ExtractFindingsInput {
  sourceText: string;
  context: unknown[];
  entities: LiveSummaryEntityDto[];
  tenantId: string;
  config: Readonly<Record<string, unknown>>;
}

export interface ExtractFindingsResult {
  findings: LiveSummaryEntityDto[];
}

export interface ProposeCorrectionsInput {
  sourceText: string;
  entities: LiveSummaryEntityDto[];
  tenantId: string;
  config: Readonly<Record<string, unknown>>;
}

export interface ProposeCorrectionsResult {
  proposals: LiveAssistProposal[];
  textSha256: string;
  rejectedProposals: number;
}

/**
 * What a node handler is allowed to do — narrow on purpose: a handler that could reach the
 * session could reach the generated note.
 */
export interface RealtimeCapabilities {
  transcribe(signal?: AbortSignal): Promise<TranscribeResult>;
  generateDocument(input: GenerateDocumentInput, signal?: AbortSignal): Promise<GenerateDocumentResult>;
  extractEntities(input: ExtractEntitiesInput, signal?: AbortSignal): Promise<ExtractEntitiesResult>;
  /** PROPOSES corrections over the raw partial transcript; applies none of them. */
  proposeCorrections(input: ProposeCorrectionsInput, signal?: AbortSignal): Promise<ProposeCorrectionsResult>;
  /** Mines IMPORTANT FINDINGS from the consultation context by tenant instruction. */
  extractFindings(input: ExtractFindingsInput, signal?: AbortSignal): Promise<ExtractFindingsResult>;
  /**
   * TASK-893 §7.4 — resolve a slug-form `agentRef` to the agent's TASK (and its output schema /
   * parameters). Optional for callers that predate the rekey: when absent or `null`, the node is
   * treated as `TEXT_GENERATION`, which is exactly what every `core.agent` was before this ticket.
   */
  resolveAgent?(ref: RealtimeAgentRef, signal?: AbortSignal): Promise<RealtimeResolvedAgentView | null>;
}

// =============================================================================
// Handlers
// =============================================================================

export interface RealtimeNodeRunContext {
  /** Values resolved from this node's declared input bindings, keyed by `toPort`. */
  readonly bound: Readonly<Record<string, unknown>>;
  /** The node's OWN authored config, straight off the compiled node. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly tenantId: string;
  readonly consultationId: string;
  readonly capabilities: RealtimeCapabilities;
  readonly signal?: AbortSignal;
}

/** What a handler produced: the output dict (keyed by declared `outputKey`s) and the capability it ran. */
export interface RealtimeNodeRun {
  readonly output: Record<string, unknown>;
  readonly capability: RealtimeCapabilityKey;
}

export interface RealtimeNodeHandler {
  readonly type: string;
  readonly inputs: readonly WorkflowPortDescriptor[];
  readonly outputs: readonly WorkflowPortDescriptor[];
  run(ctx: RealtimeNodeRunContext): Promise<RealtimeNodeRun>;
}

function portsOf(type: string): WorkflowNodePorts {
  const ports = NODE_PORTS[type];
  if (!ports) throw new Error(`realtime registry: node type "${type}" declares no ports in @arcaai/workflow-contract`);
  return ports;
}

/** Required, non-empty string off the bound inputs, or `''`. */
function boundText(ctx: RealtimeNodeRunContext, port: string): string {
  const value = ctx.bound[port];
  return typeof value === 'string' ? value : '';
}

/** The node's `agentRef` in either form, or `null`. Malformed shapes read as absent — the authoring schema refuses them. */
export function readAgentRef(config: Readonly<Record<string, unknown>>): RealtimeAgentRef | null {
  const ref = config.agentRef;
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { slug, versionNumber, task } = ref as Record<string, unknown>;
  if (typeof slug === 'string' && slug.length > 0) {
    return Number.isInteger(versionNumber) && (versionNumber as number) >= 1 ? { slug, versionNumber: versionNumber as number } : { slug };
  }
  if (task === 'SPEECH_TO_TEXT' || task === 'TEXT_GENERATION' || task === 'TEXT_TO_SPEECH' || task === 'NAMED_ENTITY_RECOGNITION') return { task };
  return null;
}

/**
 * The capability a node INSTANCE is expected to run, derived from its authored config ALONE.
 *
 * The read-back counterpart of the `capability` a handler reports on success. A projection has to
 * attribute a node that FAILED as well as one that succeeded — the flush projection reports
 * `textFailed` / `nlpFailed`, and the SUMMARY node's degrade reason wins over any other node's —
 * and `RealtimeNodeOutcome.capability` is present only on `succeeded`. This is that missing half.
 *
 * It agrees with {@link CoreAgentHandler} by construction: both read the task out of
 * {@link readAgentRef} and both fall back to `TEXT_GENERATION` for a slug the host cannot resolve.
 * A caller with an outcome in hand must still PREFER the reported capability — that one is what
 * ran, this one is only what was expected.
 */
export function realtimeCapabilityOf(type: string, config?: Readonly<Record<string, unknown>>): RealtimeCapabilityKey | undefined {
  if (type !== 'core.agent') return undefined;
  switch (readAgentRef(config ?? {})?.task) {
    case 'SPEECH_TO_TEXT':
      return 'transcribe';
    case 'NAMED_ENTITY_RECOGNITION':
      return 'extractEntities';
    case 'TEXT_TO_SPEECH':
      // Not a realtime-lane task — the handler throws rather than running a capability.
      return undefined;
    default:
      return 'generateDocument';
  }
}

/**
 * `core.agent` on the realtime lane — dispatch on the RESOLVED task (INTERFACES §7.4).
 *
 *  - `SPEECH_TO_TEXT` → the live transcript (the former capture binding), under `transcript`.
 *  - `NAMED_ENTITY_RECOGNITION` → NER over the bound `in` text: `data = { entities }`, `text` =
 *    the input passed through (contract §2.4), plus `entities`/`vitals` for the projection.
 *  - `TEXT_GENERATION` → the running note, with the agent's declared output schema applied as
 *    a response format (contract N4). Also the fallback when the host cannot resolve the task.
 *  - `TEXT_TO_SPEECH` is not a realtime-lane task: it throws, and the executor degrades the node
 *    with a named reason.
 *
 * A node with no reference at all is a contract violation: it throws, nothing is generated on a
 * substituted default.
 */
class CoreAgentHandler implements RealtimeNodeHandler {
  readonly type = 'core.agent';
  readonly inputs = portsOf('core.agent').inputs;
  readonly outputs = portsOf('core.agent').outputs;

  async run(ctx: RealtimeNodeRunContext): Promise<RealtimeNodeRun> {
    const agentRef = readAgentRef(ctx.config);
    if (!agentRef) throw new Error('core.agent: `agentRef.slug` is required');

    const resolved = agentRef.task !== undefined ? null : ((await ctx.capabilities.resolveAgent?.(agentRef, ctx.signal)) ?? null);
    const task: RealtimeAgentTask = agentRef.task ?? resolved?.task ?? 'TEXT_GENERATION';

    switch (task) {
      case 'SPEECH_TO_TEXT': {
        const { transcript, pipelineId } = await ctx.capabilities.transcribe(ctx.signal);
        return { capability: 'transcribe', output: { transcript, pipelineId } };
      }
      case 'NAMED_ENTITY_RECOGNITION': {
        const sourceText = boundText(ctx, 'in');
        if (!sourceText) return { capability: 'extractEntities', output: { data: { entities: [] }, text: '', entities: [] } };
        const result = await ctx.capabilities.extractEntities({ sourceText, tenantId: ctx.tenantId }, ctx.signal);
        // `vitals` rides on the SAME response — it is a projection, not a second call.
        return {
          capability: 'extractEntities',
          output: { data: { entities: result.entities }, text: sourceText, entities: result.entities, vitals: result.vitals },
        };
      }
      case 'TEXT_TO_SPEECH':
        throw new Error('core.agent: a TEXT_TO_SPEECH agent is not a realtime-lane node — speech is a durable artifact');
      case 'TEXT_GENERATION':
      default: {
        const sourceText = boundText(ctx, 'in');
        const context = ctx.bound.context;
        const material = sourceText || (context !== undefined ? JSON.stringify(context) : '');
        const responseFormat = resolved ? outputSchemaResponseFormat(resolved.slug, resolved.outputSchema, resolved.parameters) : undefined;
        const result = await ctx.capabilities.generateDocument(
          { sourceText: material, tenantId: ctx.tenantId, config: ctx.config, agentRef, ...(responseFormat === undefined ? {} : { responseFormat }) },
          ctx.signal,
        );
        return {
          capability: 'generateDocument',
          output: { text: result.text, sections: result.sections, stats: result.stats, repaired: result.repaired },
        };
      }
    }
  }
}

export const REALTIME_NODE_HANDLERS: Readonly<Record<string, RealtimeNodeHandler>> = Object.freeze({
  'core.agent': new CoreAgentHandler(),
});

/**
 * Handlers for `core.action` instances, keyed by ACTION key — only for catalogue entries whose
 * `lane` is `realtime`. Asserted TOTAL over that set by `realtime-node-registry.test.ts`; today no
 * kept action is realtime, so this table is empty and a realtime action instance is skipped by
 * the executor as `unsupported_node_type` (observable, never silent).
 */
export const REALTIME_ACTION_HANDLERS: Readonly<Record<string, RealtimeNodeHandler>> = Object.freeze({});

/** Whether the catalogue declares any realtime action — what `REALTIME_ACTION_HANDLERS` must cover. */
export const REALTIME_ACTION_KEYS: readonly string[] = Object.freeze(
  Object.values(ACTION_CATALOGUE)
    .filter((descriptor) => descriptor.lane === 'realtime')
    .map((descriptor) => descriptor.key),
);

/**
 * The handler for an INSTANCE. A `core.action` resolves to its action's handler, wrapped so its
 * declared ports are the action's effective ports and its config is the `action` sub-config.
 * Every other type resolves by type.
 */
export function realtimeHandlerFor(type: string, config?: Readonly<Record<string, unknown>>): RealtimeNodeHandler | undefined {
  if (type === 'core.action') {
    const delegate = actionDelegateOf(config);
    const handler = delegate ? REALTIME_ACTION_HANDLERS[delegate.key] : undefined;
    if (!delegate || !handler) return undefined;
    const ports = effectivePorts('core.action', config);
    return Object.freeze({
      type: 'core.action',
      inputs: ports.inputs,
      outputs: ports.outputs,
      run: (ctx: RealtimeNodeRunContext) => handler.run({ ...ctx, config: actionConfigOf(ctx.config) }),
    });
  }
  return REALTIME_NODE_HANDLERS[type];
}

/** The action's OWN config (`config.action`), which is what its handler reads. */
function actionConfigOf(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const action = config.action;
  return typeof action === 'object' && action !== null && !Array.isArray(action) ? (action as Record<string, unknown>) : {};
}

/**
 * Whether a node type offers the `enabled` switch at all — DERIVED from the shipped config schema,
 * never from a list of names (`node-config-schemas.ts` withholds `enabled` from the two graph
 * boundaries only). An unregistered type answers `false`: it withholds a switch rather than
 * advertising one the publish-time validator rejects.
 */
export function realtimeNodeIsTogglable(type: string): boolean {
  const properties = (NODE_CONFIG_SCHEMAS[type] as Record<string, unknown> | undefined)?.properties;
  if (typeof properties !== 'object' || properties === null) return false;
  return (properties as Record<string, unknown>).enabled !== undefined;
}
