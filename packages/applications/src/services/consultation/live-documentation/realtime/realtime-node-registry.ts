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
import { NODE_PORTS, type WorkflowNodePorts, type WorkflowPortDescriptor } from '@arcaai/workflow-contract';
import type { LiveSummaryEntityDto, LiveSummarySectionDto, LiveSummaryStatsDto, LiveSummaryVitalsDto } from '../dto';

/** Node types the realtime runtime implements. See `realtime-lane.ts` §lane membership. */
export const REALTIME_NODE_TYPES: ReadonlySet<string> = new Set([
  'consultation.captureBinding',
  'consultation.extractEntities',
  'consultation.realtimeSummary',
]);

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
}

// =============================================================================
// Handlers
// =============================================================================

export interface RealtimeNodeRunContext {
  /** Values resolved from this node's declared input bindings, keyed by `toPort`. */
  readonly bound: Readonly<Record<string, unknown>>;
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

export const REALTIME_NODE_HANDLERS: Readonly<Record<string, RealtimeNodeHandler>> = Object.freeze({
  'consultation.captureBinding': new CaptureBindingHandler(),
  'consultation.extractEntities': new ExtractEntitiesHandler(),
  'consultation.realtimeSummary': new RealtimeSummaryHandler(),
});

export function realtimeHandlerFor(type: string): RealtimeNodeHandler | undefined {
  return REALTIME_NODE_HANDLERS[type];
}
