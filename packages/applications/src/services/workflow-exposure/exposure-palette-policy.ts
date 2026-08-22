import { paletteOf, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';

/**
 * The exposure plane's palette boundary (TASK-790 W1, closing TASK-789 finding C-8).
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
 * closed, rule 00). Membership reasoning as of TASK-790:
 *
 * - `summarization` — ALLOWED. The palette the exposure plane was designed around (TASK-722); the
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
 * (`compiler.ts`: `typeof config.gateType === 'string' ? config.gateType : node.type`). A gate
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
 * `null` when the definition may be invoked through the exposure plane; otherwise a short reason
 * naming the offending palette (for the server-side sys-event — the CALLER gets a bare 404, never
 * this string, so the gate never discloses what a tenant has authored).
 */
export function exposureBoundaryViolation(definition: { paletteKey: string; graph?: unknown; compiledConfig?: unknown }): string | null {
  if (!EXPOSURE_ALLOWED_PALETTES.has(definition.paletteKey)) {
    return `declared palette '${definition.paletteKey}' is not exposable`;
  }

  for (const nodeType of collectNodeTypes(definition.graph, definition.compiledConfig)) {
    const palette = paletteOf(nodeType);
    // `undefined` = palette-agnostic (registry `paletteKey: null`) or an unregistered type.
    // Unregistered types cannot compile, so they can never reach a published definition.
    if (palette === undefined) continue;
    if (!EXPOSURE_ALLOWED_PALETTES.has(palette)) {
      return `node '${nodeType}' belongs to non-exposable palette '${palette}'`;
    }
  }

  return null;
}
