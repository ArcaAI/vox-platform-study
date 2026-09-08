import { CORE_PALETTE_KEY, actionDelegateOf, paletteOf, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { isRealtimeNode } from '../consultation/live-documentation/realtime/realtime-node-registry';

/**
 * The keys the interpreter reads as RUN IDENTITY, which a caller may therefore never supply
 * (lane A step 2). Byte-identical to `RESERVED_RUN_IDENTITY_KEYS` in
 * `apps/harness/src/harness/temporal/interpreter/models.py` — two spellings of this list is a
 * gateway that accepts a key the dispatcher then strips, or worse, one it does not.
 *
 * The gateway REFUSES rather than drops. A silent drop would let a caller send
 * `{"consultationId": "..."}`, receive a 202, and believe it had addressed that consultation
 * while the run acted on something else (or nothing) — the failure would surface as missing
 * clinical data, hours later, with no error anywhere. A 400 naming the key is the honest answer.
 */
export const RESERVED_RUN_IDENTITY_KEYS: readonly string[] = Object.freeze(['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']);

/** The reserved identity keys present in a caller's invocation input — empty when it is clean. */
export function reservedIdentityKeysIn(input: Record<string, unknown> | undefined): string[] {
  if (input === null || typeof input !== 'object') return [];
  return RESERVED_RUN_IDENTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
}

/**
 * The exposure plane's palette boundary (closing finding C-8).
 *
 * ## Why this exists
 *
 * `POST /workflows/:slug/invoke` forwards caller-controlled `dto.input` verbatim into
 * `InterpreterInput.payload` with `sandbox: false`. The interpreter's own suppression of
 * external writes reads `if inp.sandbox and spec.external_write:`
 * (`apps/harness/src/harness/temporal/interpreter/workflow.py`) — it fires ONLY in sandbox, so
 * it does not apply here. A consultation-palette node reached through this plane therefore calls
 * the SAME `persist_draft` activity `HarnessDocWorkflow` uses, writing real `ContextItem` rows
 * into a live consultation identified entirely by caller-supplied `consultationId` /
 * `externalPatientId` in that payload.
 *
 * The route is API-key-reachable by design (it deliberately carries no `@ForbidApiKey`), and
 * `paletteKey` is a free-text field in Workflow Studio. So the boundary has to be server-side,
 * structural, and independent of what the author declared.
 *
 * ## Why it is not keyed on `paletteKey` alone
 *
 * The ticket's expected shape was "a palette allow-list on the exposure route". That is not
 * sufficient on its own, and this was verified against the real engine rather than assumed:
 * NOTHING in `validate()` or `compile()` requires a graph's nodes to belong to its declared
 * palette. `validate()`'s per-rule loop only SKIPS rules belonging to other palettes
 * (`validate.ts`: `if (rule.paletteKey !== null && rule.paletteKey !== ctx.paletteKey) continue`)
 * — it never asserts membership. A graph declaring `paletteKey: 'summarization'` while carrying
 * `consultation.persistDraft` validates shape-clean and compiles successfully. Keying the gate on
 * the declared palette would leave the C-8 chain fully open to a one-word edit.
 *
 * So the gate resolves the palette of every NODE TYPE the definition actually carries, from two
 * independent sources (see `collectNodeTypes`), and refuses if any of them lands outside the
 * allow-list. Declared `paletteKey` is checked too — belt and braces, and it catches a definition
 * whose graph is empty or unreadable.
 */

/**
 * Palettes whose graphs may be invoked through the PUBLIC exposure plane.
 *
 * Deliberately an ALLOW-list, not a deny-list: a palette added to the registry later is refused
 * here until someone affirmatively decides it is an exposure product (config selection fails
 * closed, rule 00). Since TASK-893 the registry declares ONE palette — `core` — and the legacy
 * `summarization` / `consultation` / `agentic` / `stt` palettes are gone, so the real boundary on
 * this plane is the CLASS-based `clinicalWriteViolation` below, not palette membership.
 */
export const EXPOSURE_ALLOWED_PALETTES: ReadonlySet<string> = new Set([CORE_PALETTE_KEY]);

/**
 * Palettes invocable on the CONSULTATION-BOUND plane
 * (`POST /consultations/:consultationId/workflows/:slug/runs`) — lane A step 3.
 *
 * A SECOND, narrower plane that only exists once the server has resolved a consultation binding
 * from the URL (re-resolved against the caller's tenant, frozen into `StartWorkflowRunInput.subject`;
 * a caller-supplied identity key in `input` is a 400 and the dispatcher strips those keys
 * unconditionally). On THIS plane a clinical write is the FEATURE: it writes to the caller's own
 * consultation, so `clinicalWriteViolation` is not applied here. Both planes admit the same one
 * palette since TASK-893; what differs is the clinical-write rule and the required ability/scope.
 */
export const CONSULTATION_BOUND_ALLOWED_PALETTES: ReadonlySet<string> = new Set([CORE_PALETTE_KEY]);

/**
 * TASK-864 — the CLASS-BASED rule that replaces palette membership as the real boundary for the
 * `core` vocabulary (§3.4): a graph is invokable on the UNBOUND plane unless it carries an
 * `externalWrite` CLINICAL action — one that writes into a consultation's own rows. The Output
 * node's claim-check publish and a TTS artifact are external writes too, but they write to the
 * run, not to a patient record, which is exactly the distinction C-8 turned on.
 *
 * Resolved per INSTANCE: a `core.action` writes if its catalogue entry writes (`actionDelegateOf`
 * → `externalWrite`). Every `externalWrite` action in `ACTION_CATALOGUE` writes into a
 * consultation's own rows (`persistDraft`, `finalizeAssurance`, the endpoint stage), so the flag
 * IS the clinical-write class.
 */
function clinicalWriteViolation(nodes: ReadonlyArray<{ type: string; config?: Readonly<Record<string, unknown>> }>): string | null {
  for (const node of nodes) {
    if (node.type !== 'core.action') continue;
    const delegate = actionDelegateOf(node.config);
    if (delegate === undefined) continue;
    if (delegate.externalWrite) {
      return `action '${delegate.key}' writes into a consultation — invokable only through the consultation-bound route`;
    }
  }
  return null;
}

/** Every palette key the node registry actually declares — the create-time validation set for
 *  `WorkflowDefinition.paletteKey` (W1's second half / findings C-5, D-5). Derived from the
 *  registry rather than re-typed, so a new palette needs no edit here. */
export const KNOWN_PALETTE_KEYS: ReadonlySet<string> = new Set(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .map((descriptor) => descriptor.paletteKey)
    .filter((key): key is string => key !== null),
);

/**
 * The node types a definition actually carries, from two independent sources:
 *
 * 1. `graph.nodes[].type` — what the author wrote. Authoritative, and the only source that
 *    survives the compiler's gate lifting.
 * 2. `compiledConfig.stages[].nodes[].type` — what will actually be dispatched.
 *
 * Both are read because neither alone is complete. `compile()` lifts `gate`-class nodes OUT of
 * `stages` into `gates`, where the type is recorded as `gateType` — and `gateType` falls back to
 * the node type only when the AUTHOR did not supply `config.gateType`
 * (`compiler.ts`: `typeof config.gateType === 'string' ? config.gateType: node.type`). A gate
 * node with an author-supplied `config.gateType` would therefore be invisible in `gates`; reading
 * the graph closes that. Reading the compiled config as well means a compiled blob that somehow
 * disagrees with its graph is judged on both.
 *
 * Unreadable input contributes no types rather than throwing — the caller still checks the
 * declared `paletteKey`, so an empty/garbled graph can never widen the boundary.
 */
function collectNodeTypes(graph: unknown, compiledConfig: unknown): Set<string> {
  const types = new Set<string>();

  const graphNodes = (graph as { nodes?: unknown })?.nodes;
  if (Array.isArray(graphNodes)) {
    for (const node of graphNodes) {
      const type = (node as { type?: unknown })?.type;
      if (typeof type === 'string') types.add(type);
    }
  }

  const stages = (compiledConfig as { stages?: unknown })?.stages;
  if (Array.isArray(stages)) {
    for (const stage of stages) {
      const stageNodes = (stage as { nodes?: unknown })?.nodes;
      if (!Array.isArray(stageNodes)) continue;
      for (const node of stageNodes) {
        const type = (node as { type?: unknown })?.type;
        if (typeof type === 'string') types.add(type);
      }
    }
  }

  return types;
}

/**
 * Which plane the caller reached the definition on.
 *
 * `consultationBound: true` means the SERVICE has already re-resolved a consultation from a path
 * parameter against the caller's tenant and will freeze it into the run's `subject`. It is never
 * derived from anything a caller sends — a request body cannot set it, and a controller may only
 * pass it on a route whose URL carries the consultation id.
 */
export interface ExposureBoundaryContext {
  consultationBound?: boolean;
}

/**
 * `null` when the definition may be invoked through the exposure plane; otherwise a short reason
 * naming the offending palette (for the server-side sys-event — the CALLER gets a bare 404, never
 * this string, so the gate never discloses what a tenant has authored).
 */
export function exposureBoundaryViolation(
  definition: { paletteKey: string; graph?: unknown; compiledConfig?: unknown },
  context: ExposureBoundaryContext = {},
): string | null {
  const allowed = context.consultationBound === true ? CONSULTATION_BOUND_ALLOWED_PALETTES : EXPOSURE_ALLOWED_PALETTES;

  if (!allowed.has(definition.paletteKey)) {
    return `declared palette '${definition.paletteKey}' is not exposable`;
  }

  const nodeTypes = collectNodeTypes(definition.graph, definition.compiledConfig);
  const nodes = collectNodes(definition.graph, definition.compiledConfig);

  // TASK-864 — the class-based rule, over the authored AND the compiled nodes (the author is not
  // trusted, C-8). Checked on the UNBOUND plane only: the bound plane has a server-resolved
  // consultation to write into, which is what makes those writes safe there.
  if (context.consultationBound !== true) {
    const clinical = clinicalWriteViolation(nodes);
    if (clinical) return clinical;
  }

  for (const nodeType of nodeTypes) {
    const palette = paletteOf(nodeType);
    // `undefined` = palette-agnostic (registry `paletteKey: null`) or an unregistered type.
    // Unregistered types cannot compile, so they can never reach a published definition.
    if (palette === undefined) continue;
    if (!allowed.has(palette)) {
      return `node '${nodeType}' belongs to non-exposable palette '${palette}'`;
    }
  }

  return realtimeOnlyViolation(nodes);
}

/** Every node INSTANCE a definition carries (type + config), from the same two sources as `collectNodeTypes`. */
function collectNodes(graph: unknown, compiledConfig: unknown): Array<{ type: string; config?: Readonly<Record<string, unknown>> }> {
  const nodes: Array<{ type: string; config?: Readonly<Record<string, unknown>> }> = [];
  const push = (node: unknown) => {
    const record = node as { type?: unknown; config?: unknown };
    if (typeof record?.type !== 'string') return;
    nodes.push({
      type: record.type,
      config: typeof record.config === 'object' && record.config !== null ? (record.config as Record<string, unknown>) : undefined,
    });
  };
  const graphNodes = (graph as { nodes?: unknown })?.nodes;
  if (Array.isArray(graphNodes)) graphNodes.forEach(push);
  const stages = (compiledConfig as { stages?: unknown })?.stages;
  if (Array.isArray(stages)) {
    for (const stage of stages) {
      const stageNodes = (stage as { nodes?: unknown })?.nodes;
      if (Array.isArray(stageNodes)) stageNodes.forEach(push);
    }
  }
  return nodes;
}

/**
 * A graph whose only real work is `lane: 'realtime'` is refused on BOTH planes.
 *
 * The Temporal interpreter deliberately skips every realtime node — that lane belongs to the
 * in-gateway `runRealtimeLane` executor, driven by a live consultation session, not by an
 * invocation. Accepting such an invoke would return a `runId`, report `COMPLETED`, and have done
 * nothing. Since TASK-893 lane is a property of the INSTANCE (`core.agent` / `core.action`
 * `execution.lane`, an action inheriting its catalogue entry's), so this is judged per node, not
 * per type — the same predicate `isRealtimeNode` applies at flush time. A MIXED graph is allowed:
 * only a graph with no durable work at all is a promise the interpreter cannot keep.
 */
function realtimeOnlyViolation(nodes: ReadonlyArray<{ type: string; config?: Readonly<Record<string, unknown>> }>): string | null {
  let realtime = 0;
  let durable = 0;
  for (const node of nodes) {
    const descriptor = WORKFLOW_NODE_REGISTRY[node.type];
    if (descriptor === undefined) continue;
    // Boundaries and annotations are structural, not work.
    if (descriptor.classes.includes('boundary') || descriptor.classes.includes('annotation')) continue;
    if (isRealtimeNode(node.type, node.config)) realtime += 1;
    else durable += 1;
  }
  if (realtime > 0 && durable === 0) {
    return 'every node is lane:realtime — the durable interpreter would run nothing';
  }
  return null;
}
