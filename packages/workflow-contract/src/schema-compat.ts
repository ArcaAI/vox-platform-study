/**
 * TIER 2 of TASK-847 step 7 — the shallow structural check, and the tier whose defining property
 * is restraint.
 *
 * ## The three tiers, and which one is the authority
 *
 * | Tier | What it checks | When | Blocks? |
 * |---|---|---|---|
 * | 1 | Port KIND (`portKindOf`, `port-model.ts`) | on every canvas drag | **yes** — `isValidConnection` |
 * | 1b | Port PRIMITIVE lattice (`portPrimitiveSatisfies`) | at publish | **yes** — `workflowPublishProblems` |
 * | **2** | **shallow schema shape — THIS MODULE** | at publish | **never** |
 * | 3 | full schema validation of the actual payload | at run time, at the node boundary | yes, at run time |
 *
 * Tier 3 is where correctness actually lives, because it is the only tier that sees a real
 * payload. Tier 2 sees two DECLARATIONS and guesses whether they will fit — which makes it
 * useful as a hint and disqualifying as a gate.
 *
 * ## Why it is deliberately weak
 *
 * > *A validator that cries wolf is the most hated feature you can ship.*
 *
 * Every limitation below is chosen, not missing:
 *
 *  - **One level deep.** A nested mismatch is real, but a shallow reader cannot tell a genuine
 *    one from a shape it simply does not understand, and the second kind is the one that trains
 *    authors to ignore the rail.
 *  - **Composition keywords skip the pair ENTIRELY** (`oneOf`, `allOf`, `anyOf`, `if`). These
 *    change what `required` and `type` even mean; reading them shallowly produces confident
 *    nonsense. Silence is the honest answer.
 *  - **`patternProperties` skips too** — a pattern can satisfy a property name this reader
 *    cannot enumerate, so "the producer does not declare it" would simply be false.
 *  - **Absence is never a mismatch.** A node with no declared schema is un-annotated, not wrong.
 *
 * ## The escape hatch is part of the message
 *
 * When tier 2 warns, the remedy is an `agentic.data` node on the edge — which is precisely what
 * that node type exists for. A warning with no remedy is noise, so the remedy is named in the
 * text rather than left in a doc.
 */
import type { WorkflowGraph } from './graph-model';

/** Keywords whose presence makes a shallow read meaningless. Their presence on EITHER side skips
 *  the whole comparison. */
const COMPOSITION_KEYWORDS = ['oneOf', 'allOf', 'anyOf', 'if', 'then', 'else', 'not', 'patternProperties', '$ref'] as const;

type JsonSchemaLike = Record<string, unknown>;

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchemaLike) : undefined;
}

function usesComposition(schema: JsonSchemaLike): boolean {
  return COMPOSITION_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

function propertiesOf(schema: JsonSchemaLike): Record<string, JsonSchemaLike> {
  const properties = asSchema(schema.properties);
  if (properties === undefined) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => (asSchema(value) === undefined ? [] : [[key, asSchema(value) as JsonSchemaLike]])),
  );
}

function requiredOf(schema: JsonSchemaLike): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
}

/** The declared `type`, as a single string, or `undefined` for an absent or union type — a union
 *  is a composition in all but name, and comparing one shallowly is the same mistake. */
function primitiveOf(schema: JsonSchemaLike): string | undefined {
  return typeof schema.type === 'string' ? schema.type : undefined;
}

/**
 * Compare a PRODUCER's declared output shape against a CONSUMER's declared input shape, one
 * level deep. Returns human-readable warnings; the caller stamps `severity: 'WARNING'`, and there
 * is no code path here that produces anything else.
 */
export function schemaCompatWarnings(producerSchema: unknown, consumerSchema: unknown): string[] {
  const producer = asSchema(producerSchema);
  const consumer = asSchema(consumerSchema);
  if (producer === undefined || consumer === undefined) return [];
  if (usesComposition(producer) || usesComposition(consumer)) return [];
  // Only object-to-object is comparable at this grain. Anything else (an array, a scalar, an
  // un-typed schema) is left to tier 1's port lattice and tier 3's runtime check.
  if (primitiveOf(producer) !== 'object' || primitiveOf(consumer) !== 'object') return [];

  const produced = propertiesOf(producer);
  const consumed = propertiesOf(consumer);
  const warnings: string[] = [];

  for (const name of requiredOf(consumer)) {
    if (produced[name] === undefined) {
      warnings.push(
        `the consumer requires \`${name}\`, which the producer does not declare. If the field arrives under a different name, insert an \`agentic.data\` node on this edge and map it; if it genuinely never arrives, this edge is wrong.`,
      );
    }
  }

  for (const [name, consumedProperty] of Object.entries(consumed)) {
    const producedProperty = produced[name];
    if (producedProperty === undefined) continue;
    if (usesComposition(producedProperty) || usesComposition(consumedProperty)) continue;
    const producedType = primitiveOf(producedProperty);
    const consumedType = primitiveOf(consumedProperty);
    if (producedType === undefined || consumedType === undefined) continue;
    // `integer` is a `number`; nothing else widens at this grain.
    if (producedType === consumedType) continue;
    if (producedType === 'integer' && consumedType === 'number') continue;
    warnings.push(
      `\`${name}\` is \`${producedType}\` on the producer and \`${consumedType}\` on the consumer. Insert an \`agentic.data\` node on this edge to convert it, or correct one of the two schemas.`,
    );
  }

  return warnings;
}

/**
 * Which config key on a node type carries its declared OUTPUT shape, and which its INPUT shape.
 *
 * Only the `agentic.*` types annotate their boundaries — that is what a tenant-defined schema
 * IS — so the table is short and closed. A node type absent from it contributes no tier-2
 * warnings, which is the correct silence rather than a gap: the pipeline palettes' shapes are
 * fixed by their activities, not declared by the author.
 */
const OUTPUT_SCHEMA_KEY: Readonly<Record<string, string>> = Object.freeze({
  'agentic.input': 'ioSchema',
  'agentic.data': 'outputSchema',
  'agentic.agent': 'responseSchema',
});

const INPUT_SCHEMA_KEY: Readonly<Record<string, string>> = Object.freeze({
  'agentic.output': 'ioSchema',
});

/** Ports that carry ORDERING and no payload. An edge on one of these has nothing to mismatch. */
const CONTROL_PORT_NAMES: ReadonlySet<string> = new Set(['after', 'next']);

export interface SchemaCompatFinding {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /** Always `'WARNING'`. Typed as the literal rather than the union so a future change that makes
   *  tier 2 blocking has to be a deliberate type change, not an accident at one call site. */
  readonly severity: 'WARNING';
  readonly message: string;
}

/**
 * Run tier 2 over a whole graph, attributing each warning to the EDGE it belongs to so the canvas
 * can draw it where the author can see the two ends.
 */
export function workflowEdgeSchemaWarnings(graph: WorkflowGraph): SchemaCompatFinding[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const findings: SchemaCompatFinding[] = [];

  for (const edge of graph.edges) {
    if (CONTROL_PORT_NAMES.has(edge.fromPort) || CONTROL_PORT_NAMES.has(edge.toPort)) continue;
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const outputKey = OUTPUT_SCHEMA_KEY[from.type];
    const inputKey = INPUT_SCHEMA_KEY[to.type];
    if (outputKey === undefined || inputKey === undefined) continue;

    const producerSchema = (from.config as Record<string, unknown> | undefined)?.[outputKey];
    const consumerSchema = (to.config as Record<string, unknown> | undefined)?.[inputKey];

    for (const message of schemaCompatWarnings(producerSchema, consumerSchema)) {
      findings.push({ edgeId: edge.id, fromNodeId: edge.from, toNodeId: edge.to, severity: 'WARNING', message });
    }
  }

  return findings;
}
