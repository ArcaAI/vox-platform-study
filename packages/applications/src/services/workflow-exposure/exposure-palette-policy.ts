import { paletteOf, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';

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
 * closed, rule 00). Membership reasoning as of :
 *
 * `summarization` — ALLOWED. The palette the exposure plane was designed around; the
 *   seeded platform-default definition and the `InvokeWorkflowRequest` DTO example are both
 *   summarization. Its one `externalWrite` node (`output.deliver`) writes to claim-check storage,
 *   not to clinical rows.
 * - `consultation` — REFUSED. This is finding C-8 itself. Four of its thirteen nodes declare
 *   `externalWrite`, and `consultation.persistDraft` reaches the same activity the real
 *   consultation workflow uses.
 * - `stt` — REFUSED. Not because it is dangerous but because it is not a product on this plane:
 *   every `stt` interpreter node is an explicit registry-parity PLACEHOLDER that returns
 *   `DEGRADED` without doing work (`interpreter/nodes/stt_placeholder.py`). The palette's real
 *   artifact is the `AsrPipeline` compiled at publish time; invoking the graph over REST would
 *   promise transcription and silently deliver nothing.
 *
 * Palette-agnostic node types (`noop`, `passthrough`, `core.start`, `core.end` — `paletteKey:
 * null` in the registry) belong to no palette and are always permitted.
 */
export const EXPOSURE_ALLOWED_PALETTES: ReadonlySet<string> = new Set(['summarization']);

/**
 * Palettes invocable on the CONSULTATION-BOUND plane
 * (`POST /consultations/:consultationId/workflows/:slug/runs`) — lane A step 3.
 *
 * ## This is not `EXPOSURE_ALLOWED_PALETTES` with `consultation` added to it
 *
 * It is a SECOND, narrower plane that only exists once the server has resolved a consultation
 * binding, and the distinction is the whole safety argument. The set above is unchanged: on the
 * unbound plane a consultation graph is refused today exactly as C-8 left it. What changed is
 * that there is now a plane on which the C-8 chain has no links left to exploit, and this set
 * governs only that plane.
 *
 * The invariant, from :
 *
 *   > consultation identity comes from the URL and is re-resolved against the caller's tenant —
 *   > never from a caller-composed payload.
 *
 * preserved it with a session-bound entry point; lane A preserves it with an
 * invocation-bound one. Against C-8's four links:
 *
 * 1. **`consultationId` from caller-controlled `dto.input`** — the id is a PATH parameter,
 *    re-resolved through `IConsultationService.getById` (tenant-scoped; a foreign or unknown id
 *    is simply absent ⇒ 404) and frozen into `StartWorkflowRunInput.subject`. A caller-supplied
 *    identity key in `input` is a 400, and the harness dispatcher strips those keys from the
 *    payload unconditionally (`sanitize_run_payload`) — so the payload cannot carry identity at
 *    all, for any caller.
 * 2. **`sandbox: false`, so external-write suppression never fires** — still true, and no longer
 *    the thing standing between a caller and a write. Suppression answered "may this run write?";
 *    the binding answers "WHERE may it write?", and the answer is one row the caller has already
 *    been authorised for. A suppression flag could not have expressed that.
 * 3. **`consultation.persistDraft` reaches the shared activity** — it does, and now that is the
 *    FEATURE: it writes to the caller's own consultation. `persistDraft` resolves its target via
 *    `run_identity(...)`, which reads only the server-stamped keys.
 * 4. **API-key reachable; `paletteKey` is free text** — the gate still resolves NODE types, never
 *    the declared palette, and the bound plane additionally requires the
 *    `ConsultationWorkflow:execute` ability and the `workflows:execute` scope, which is a
 *    separate top-level scope prefix so an existing `workflow`-scoped key does NOT inherit it.
 *
 * `stt` stays refused on BOTH planes for its original reason (placeholder nodes that promise
 * transcription and deliver nothing), and `agentic` is refused for want of an affirmative
 * decision — config selection fails closed.
 */
export const CONSULTATION_BOUND_ALLOWED_PALETTES: ReadonlySet<string> = new Set(['summarization', 'consultation']);

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

  for (const nodeType of nodeTypes) {
    const palette = paletteOf(nodeType);
    // `undefined` = palette-agnostic (registry `paletteKey: null`) or an unregistered type.
    // Unregistered types cannot compile, so they can never reach a published definition.
    if (palette === undefined) continue;
    if (!allowed.has(palette)) {
      return `node '${nodeType}' belongs to non-exposable palette '${palette}'`;
    }
  }

  return realtimeOnlyViolation(nodeTypes);
}

/**
 * A graph whose only real work is `lane: 'realtime'` is refused on BOTH planes.
 *
 * The Temporal interpreter deliberately skips every realtime node — that lane belongs to
 * in-gateway `runRealtimeLane` executor, driven by a live consultation session, not
 * by an invocation. Accepting such an invoke would return a `runId`, report `COMPLETED`, and
 * have done nothing: the developer gets a green response for work that never happened.
 *
 * This is the same honesty argument the `stt` refusal above already records, applied to a lane
 * rather than a palette, and it is deliberately narrow. A MIXED graph is allowed: realtime nodes
 * inside an otherwise durable graph are a legitimate authoring choice (the same published
 * definition governs both substrates), and the durable half really does run. Only a graph with
 * no durable work at all is a promise the interpreter cannot keep.
 */
function realtimeOnlyViolation(nodeTypes: Set<string>): string | null {
  let realtime = 0;
  let durable = 0;
  for (const nodeType of nodeTypes) {
    const descriptor = WORKFLOW_NODE_REGISTRY[nodeType];
    if (descriptor === undefined) continue;
    // Boundary markers (`core.start`/`core.end`) and `noop`/`passthrough` are structural, not
    // work — a graph of nothing but markers plus realtime nodes still does nothing durable.
    if (descriptor.classes.includes('boundary') || nodeType === 'noop' || nodeType === 'passthrough') continue;
    if (descriptor.lane === 'realtime') realtime += 1;
    else durable += 1;
  }
  if (realtime > 0 && durable === 0) {
    return 'every node is lane:realtime — the durable interpreter would run nothing';
  }
  return null;
}
