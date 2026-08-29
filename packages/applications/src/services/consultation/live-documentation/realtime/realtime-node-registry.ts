/**
 * TASK-811 — the REALTIME node registry: which node types this runtime can run,
 * and what each one does.
 *
 * ## Task 7 — `LIVE_TOOL_KEYS` becomes node dispatch
 *
 * The live plane used to decide what ran from a three-boolean allow-list
 * (`LIVE_TOOL_KEYS = ['ner','vitals','groundedness']`, D-13). Three booleans
 * cannot express "run this node, bound to that port, with this budget, and
 * degrade this way" — which is why a tenant could author a graph and have it
 * govern nothing. Here, a node RUNS because the lane contains it, and it
 * receives what its DECLARED PORTS say it receives.
 *
 * `vitals` survives as what it always was: a projection of the SAME
 * `nlp.classify-tokens` response the entity node already makes. It was never a
 * second call and does not become a second node.
 *
 * ## Ports come from `@arcaai/workflow-contract`, never from here
 *
 * Every handler reads its port descriptors out of `NODE_PORTS`. That is what
 * makes the anti-laundering rule structural rather than conventional: this file
 * cannot widen `consultation.extractEntities.in` from `transcript` to `text`,
 * because it does not own the declaration.
 */
import { NODE_PORTS, WORKFLOW_NODE_REGISTRY, type WorkflowNodePorts, type WorkflowPortDescriptor } from '@arcaai/workflow-contract';
import type { HarnessLiveAssistProposalDto } from '../../harness/dto';
import type { LiveSummaryEntityDto, LiveSummarySectionDto, LiveSummaryStatsDto, LiveSummaryVitalsDto } from '../dto';

/** The wire shape a correction proposal already has on the live-assist plane. Reused rather
 *  than redeclared: the realtime pass publishes onto that SAME channel, so a second shape
 *  would be a second contract for one payload. */
type LiveAssistProposal = HarnessLiveAssistProposalDto;

/**
 * Node types the realtime runtime implements — DERIVED from the contract, not listed here
 * (TASK-806 lane A, item 7).
 *
 * This used to be a hand-kept set of three keys, and `realtime-lane.ts` explained at length why it
 * had to be: `WorkflowNodeDescriptor.lane` said `durable` on every node type, the contract package
 * refused a `realtime` node that was `externalWrite`, and no runtime read `lane` anyway. All three
 * of those are now false — the rule that refused a writing realtime node was falsified by this
 * very runtime and has been removed, `lane` carries the truth, and the durable interpreter SKIPS a
 * `realtime` node (`workflow.py`, reason `realtime_lane`) so exactly one runtime executes a given
 * node.
 *
 * Deriving it is the point rather than a tidy-up: two sources of truth for "which runtime owns
 * this node" is how the durable interpreter came to re-run nodes this executor already owns, and
 * for `consultation.realtimeSummary` (`externalWrite: true`) that is two engines writing one
 * consultation's document. `REALTIME_NODE_HANDLERS` below is asserted total over this set, so a
 * node flipped to `realtime` in the contract with no handler here is a failing test, never a
 * silent no-op at flush time.
 */
export const REALTIME_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.lane === 'realtime')
    .map((descriptor) => descriptor.key),
);

// =============================================================================
// Capabilities — the NARROW port the host service implements
// =============================================================================

export interface TranscribeResult {
  /** The transcript this turn contributes. Raw ASR output — never generated text. */
  transcript: string;
  /**
   * The `AsrPipeline` this capture is bound to, or null when the tenant has no
   * `stt`-palette assignment and the session runs the default pipeline.
   */
  pipelineId: string | null;
}

export interface GenerateDocumentInput {
  /** The transcript this turn contributes, resolved from the node's declared `in` port. */
  sourceText: string;
  tenantId: string;
}

export interface GenerateDocumentResult {
  /** The rendered running note. */
  text: string;
  sections: LiveSummarySectionDto[];
  stats: LiveSummaryStatsDto | null;
  /** Whether the bounded JSON auto-repair retry ran. */
  repaired: boolean;
}

export interface ExtractEntitiesInput {
  /**
   * RAW transcript. One field, by design — the same structural guarantee
   * `ExtractionToolInput` carries in `live-tool-registry.ts`. There is no field
   * on this type through which generated text could reach NER.
   */
  sourceText: string;
  tenantId: string;
}

export interface ExtractEntitiesResult {
  entities: LiveSummaryEntityDto[];
  vitals?: LiveSummaryVitalsDto;
}

export interface ProposeCorrectionsInput {
  /**
   * RAW transcript, resolved from the node's declared `in: transcript` port. Same structural
   * guarantee `ExtractEntitiesInput` carries: there is no field on this type through which a
   * generated note could reach the grammar pass.
   */
  sourceText: string;
  /**
   * The detector hints the SAME flush already produced, resolved from the optional
   * `entities` port. Empty when the lane has no NER node — the pass still runs.
   */
  entities: LiveSummaryEntityDto[];
  tenantId: string;
  /**
   * The node's OWN authored config. It carries the prompt binding
   * (`promptTemplateId`/`promptVersionNumber`) and the correction task/tuning knobs — the prompt
   * is CONFIG, resolved per node instance, never a literal in this runtime.
   */
  config: Readonly<Record<string, unknown>>;
}

export interface ProposeCorrectionsResult {
  /**
   * Proposals that survived verification against the source. A proposal whose `[start, end)`
   * does not equal its own `original` is DROPPED, because accepting it in a one-click UI would
   * splice the replacement over the wrong characters.
   */
  proposals: LiveAssistProposal[];
  /** sha256 of the exact bytes the spans were measured against, so a console cannot accept a
   *  proposal into text that has since drifted. */
  textSha256: string;
  rejectedProposals: number;
}

/**
 * What a node handler is allowed to do. Deliberately three narrow methods rather
 * than the whole `LiveDocumentationService`: a handler that could reach the
 * session could reach the generated note, and the type-level half of the
 * anti-laundering rule would be gone.
 */
export interface RealtimeCapabilities {
  transcribe(signal?: AbortSignal): Promise<TranscribeResult>;
  generateDocument(input: GenerateDocumentInput, signal?: AbortSignal): Promise<GenerateDocumentResult>;
  extractEntities(input: ExtractEntitiesInput, signal?: AbortSignal): Promise<ExtractEntitiesResult>;
  /** Lane R (R1). PROPOSES corrections over the raw partial transcript; applies none of them. */
  proposeCorrections(input: ProposeCorrectionsInput, signal?: AbortSignal): Promise<ProposeCorrectionsResult>;
}

// =============================================================================
// Handlers
// =============================================================================

export interface RealtimeNodeRunContext {
  /** Values resolved from this node's declared input bindings, keyed by `toPort`. */
  readonly bound: Readonly<Record<string, unknown>>;
  /**
   * The node's OWN authored config, straight off the compiled node.
   *
   * Distinct from `bound` on purpose: `bound` is what UPSTREAM NODES produced and is type-checked
   * against the port table, while this is what the TENANT AUTHORED on this instance. A per-node
   * prompt binding is the second kind, and there is nowhere else for it to come from — resolving
   * it from anything but the node would make one node's config govern another's call.
   */
  readonly config: Readonly<Record<string, unknown>>;
  readonly tenantId: string;
  readonly consultationId: string;
  readonly capabilities: RealtimeCapabilities;
  readonly signal?: AbortSignal;
}

export interface RealtimeNodeHandler {
  readonly type: string;
  readonly inputs: readonly WorkflowPortDescriptor[];
  readonly outputs: readonly WorkflowPortDescriptor[];
  /**
   * Returns the node's output dict — keyed by the `outputKey`s its output ports
   * declare, exactly like a harness activity's `NodeActivityResult.output`. The
   * executor reads it back through those same declarations.
   */
  run(ctx: RealtimeNodeRunContext): Promise<Record<string, unknown>>;
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

/**
 * `consultation.captureBinding` — TASK-811 task 14, and the answer to
 * TASK-809 §2y1.
 *
 * The node's declared output is `out: transcript { outputKey: 'transcript' }`,
 * and until now that was DESIGN INTENT: the durable activity starts/stops the
 * live-documentation session and emits `{action, consultationId}`, publishing no
 * transcript at all. The consultation palette therefore had NO producer of
 * `transcript`, which made `consultation.extractEntities`' required `in:
 * transcript` unsatisfiable in every graph — the node degraded on `no_bound_text`
 * and the port declaration was a promise nothing kept.
 *
 * In the REALTIME lane it is kept. Capture binds the live ASR stream — the
 * session's ingested STT finals, produced by the tenant's `AsrPipeline` — and
 * publishes them under `transcript`. Downstream nodes resolve their transcript
 * input through the port, not through a `delta || transcript` expression the
 * flush happened to have in scope.
 */
class CaptureBindingHandler implements RealtimeNodeHandler {
  readonly type = 'consultation.captureBinding';
  readonly inputs = portsOf('consultation.captureBinding').inputs;
  readonly outputs = portsOf('consultation.captureBinding').outputs;

  async run(ctx: RealtimeNodeRunContext): Promise<Record<string, unknown>> {
    const { transcript, pipelineId } = await ctx.capabilities.transcribe(ctx.signal);
    return { transcript, pipelineId };
  }
}

/**
 * `consultation.extractEntities` — NER over the raw transcript.
 *
 * ITS INPUT IS `transcript`, AND THAT IS THE POINT. The LLM running note carries
 * a material hallucination base rate, so NER over the note laundered invented
 * findings and medications into first-class clinical entities. The executor
 * refuses any binding whose producer's port type does not satisfy `transcript`,
 * and `document` does not (`document ⊑ text`, `transcript ⊑ text`, siblings) —
 * so a graph wiring a generation node into this one cannot run.
 */
class ExtractEntitiesHandler implements RealtimeNodeHandler {
  readonly type = 'consultation.extractEntities';
  readonly inputs = portsOf('consultation.extractEntities').inputs;
  readonly outputs = portsOf('consultation.extractEntities').outputs;

  async run(ctx: RealtimeNodeRunContext): Promise<Record<string, unknown>> {
    const sourceText = boundText(ctx, 'in');
    if (!sourceText) return { entities: [] };
    const result = await ctx.capabilities.extractEntities({ sourceText, tenantId: ctx.tenantId }, ctx.signal);
    // `vitals` rides on the SAME response — it is a projection, not a second call.
    return { entities: result.entities, vitals: result.vitals };
  }
}

/** `consultation.realtimeSummary` — the TEXT generation producing the running note. */
class RealtimeSummaryHandler implements RealtimeNodeHandler {
  readonly type = 'consultation.realtimeSummary';
  readonly inputs = portsOf('consultation.realtimeSummary').inputs;
  readonly outputs = portsOf('consultation.realtimeSummary').outputs;

  async run(ctx: RealtimeNodeRunContext): Promise<Record<string, unknown>> {
    const sourceText = boundText(ctx, 'in');
    const result = await ctx.capabilities.generateDocument({ sourceText, tenantId: ctx.tenantId }, ctx.signal);
    // `text` is the declared `outputKey` of this node's `out: document` port.
    return { text: result.text, sections: result.sections, stats: result.stats, repaired: result.repaired };
  }
}

/**
 * `agent.grammar` — Lane R (R1). The live grammar/spelling pass.
 *
 * ITS INPUT IS `transcript`, and that is the difference from its durable sibling rather than an
 * oversight. `consultation.proposeCorrections.in` is `text` precisely so it may review a
 * generated note at the end of a consultation; this node reviews the RAW PARTIAL TRANSCRIPT the
 * clinician is watching grow, so the executor's port-type check refuses a generation node wired
 * into it exactly as it does for NER.
 *
 * It APPLIES NOTHING. `applied: false` rides on every output because a system that silently
 * rewrites a drug name or a dose in clinical text is a patient-safety defect: the corrected
 * transcript is always ADVISORY alongside the raw, and a proposal becomes real only through the
 * DD-8 accepted-proposal path.
 *
 * Entities come from the SAME flush's extraction rather than a second NER round trip — the same
 * "one call, two projections" principle `vitals` follows.
 */
class GrammarHandler implements RealtimeNodeHandler {
  readonly type = 'agent.grammar';
  readonly inputs = portsOf('agent.grammar').inputs;
  readonly outputs = portsOf('agent.grammar').outputs;

  async run(ctx: RealtimeNodeRunContext): Promise<Record<string, unknown>> {
    const sourceText = boundText(ctx, 'in');
    // Nothing was said this turn, so there is nothing to propose a correction FOR. Calling a
    // model here would invite ungrounded edits to ordinary prose — the same reason the durable
    // engine returns early.
    if (!sourceText) return { proposals: [], applied: false };

    const bound = ctx.bound.entities;
    const entities = Array.isArray(bound) ? (bound as LiveSummaryEntityDto[]) : [];

    const result = await ctx.capabilities.proposeCorrections(
      { sourceText, entities, tenantId: ctx.tenantId, config: ctx.config },
      ctx.signal,
    );
    return {
      proposals: result.proposals,
      applied: false,
      textSha256: result.textSha256,
      rejectedProposals: result.rejectedProposals,
    };
  }
}

/**
 * `agent.transcription` and `agent.ner` are the TARGET CATALOGUE's names for capture and NER
 * (TASK-809 DD-9), and they run the SAME handler rather than a second implementation of the same
 * behaviour — `nodes/agent_catalogue.py` does exactly this on the durable side. What an alias does
 * NOT share is its port declaration: those are read from `@arcaai/workflow-contract` under the
 * alias's own key, so each node type is still validated against what it itself declares.
 */
function aliasHandler(type: string, delegate: RealtimeNodeHandler): RealtimeNodeHandler {
  const ports = portsOf(type);
  return Object.freeze({ type, inputs: ports.inputs, outputs: ports.outputs, run: (ctx: RealtimeNodeRunContext) => delegate.run(ctx) });
}

const captureBinding = new CaptureBindingHandler();
const extractEntities = new ExtractEntitiesHandler();

export const REALTIME_NODE_HANDLERS: Readonly<Record<string, RealtimeNodeHandler>> = Object.freeze({
  'consultation.captureBinding': captureBinding,
  'consultation.extractEntities': extractEntities,
  'consultation.realtimeSummary': new RealtimeSummaryHandler(),
  'agent.transcription': aliasHandler('agent.transcription', captureBinding),
  'agent.ner': aliasHandler('agent.ner', extractEntities),
  // NOT an alias: `consultation.proposeCorrections` stays DURABLE (it reviews the finished note
  // in the seeded graphs), so this node has no pipeline counterpart to delegate to here.
  'agent.grammar': new GrammarHandler(),
});

export function realtimeHandlerFor(type: string): RealtimeNodeHandler | undefined {
  return REALTIME_NODE_HANDLERS[type];
}

/**
 * Which PIPELINE node type an alias stands for.
 *
 * `agent.transcription` and `agent.ner` are the target catalogue's names for capture and NER and
 * run the same handlers (DD-9). A caller reading a lane's outcomes back — the flush projection in
 * `LiveDocumentationService`, a trajectory reader, anything keyed by node type — must treat the
 * two names as ONE capability, or a graph authored against the catalogue silently produces
 * nothing: the node runs, the model is paid for, and `outcomes.find(o => o.type ===
 * 'consultation.extractEntities')` returns undefined.
 *
 * A type with no pipeline counterpart is its own canonical form. `agent.grammar` is deliberately
 * one of those: its sibling `consultation.proposeCorrections` stays on the DURABLE lane, so
 * folding the two together would claim an equivalence no runtime honours.
 */
const REALTIME_ALIAS_OF: Readonly<Record<string, string>> = Object.freeze({
  'agent.transcription': 'consultation.captureBinding',
  'agent.ner': 'consultation.extractEntities',
});

export function canonicalRealtimeNodeType(type: string): string {
  return REALTIME_ALIAS_OF[type] ?? type;
}
