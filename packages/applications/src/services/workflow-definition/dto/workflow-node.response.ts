import { WORKFLOW_PORT_PRIMITIVES } from '@arcaai/workflow-contract';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One declared port on a node type — the wire projection of `WorkflowPortDescriptor`
 * (`@arcaai/workflow-contract`'s `port-model.ts`).
 *
 * This is the piece the Studio canvas cannot do its job without: `isValidConnection` needs the
 * `primitive` of both ends to decide whether an edge is legal, and `required`/`multiple` are
 * what let it distinguish "this input is missing" from "this input is optional". Before this
 * projection existed the canvas could only check that a port name was a non-empty string.
 */
export class WorkflowNodePortResponse {
  @ApiProperty({ description: 'Stable, node-type-local port name — what a graph edge’s fromPort/toPort names.' })
  name: string;

  @ApiProperty({
    enum: WORKFLOW_PORT_PRIMITIVES as unknown as string[],
    description:
      'The port’s type in the closed workflow port vocabulary. Compatibility is a subtype relation with exactly two widenings (transcript ⊑ text, document ⊑ text); transcript and document are siblings, which is what makes document → ner a type error.',
  })
  primitive: string;

  @ApiProperty({ description: 'An input the node cannot run without / an output the node always produces.' })
  required: boolean;

  @ApiProperty({ description: 'Whether the port accepts (inputs) or feeds (outputs) more than one edge.' })
  multiple: boolean;
}

/** The golden-set binding, declared on the NODE rather than on a DepartmentAgent row (OD-11). */
export class WorkflowNodeEvalGateResponse {
  @ApiProperty()
  goldenSetId: string;

  @ApiProperty()
  enabled: boolean;
}

/**
 * A read-only projection of one `WORKFLOW_NODE_REGISTRY` entry
 * (`@arcaai/workflow-contract`'s `WorkflowNodeDescriptor`) — the platform's whole node
 * vocabulary, tenant-visible by design (`admin:workflow-node:read`; see TASK-715 §6 risk #4:
 * "a node type's `description` is tenant-visible copy"). No table, no migration — this
 * package's zero-deps registry IS the source of truth (TASK-734 §6).
 */
export class WorkflowNodeResponse {
  @ApiProperty({ description: 'The node type string authored on a graph node.' })
  type: string;

  @ApiProperty({ description: 'False = an OBSERVABLE, non-executable placeholder — never silently dropped from the list.' })
  implemented: boolean;

  @ApiProperty({ description: 'The Temporal-registered activity name the compiler stamps into compiledConfig.' })
  activityName: string;

  @ApiProperty({ type: [String] })
  classes: string[];

  @ApiPropertyOptional({ nullable: true, description: 'The palette this node type belongs to, or null for a palette-agnostic utility node.' })
  paletteKey: string | null;

  @ApiProperty({ description: 'Code-owned safety property — never tenant-configurable.' })
  critical: boolean;

  @ApiProperty({ description: 'Code-owned safety property — never tenant-configurable.' })
  externalWrite: boolean;

  @ApiProperty()
  defaultTimeoutSeconds: number;

  @ApiProperty()
  defaultMaxAttempts: number;

  @ApiPropertyOptional({ nullable: true, description: 'The EntitlementFeatureKey that gates this node type, if any.' })
  entitlementKey: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'The node type’s config JSON Schema (authorable subset), or null when none has been authored for it yet — a real, structural state, not every node type has one.',
  })
  configSchema: Record<string, unknown> | null;

  // ---------------------------------------------------------------------------------------------
  // TASK-809 — the node CONTRACT. Everything above describes how a node is DISPATCHED; the fields
  // below describe what it may be WIRED TO, when it runs, and what must be true of it before a
  // graph containing it can be published. The contract package grew all of them and this DTO
  // projected none, so the canvas and the SDK could not see a single port — see
  // `__tests__/workflow-node.response-totality.test.ts`, which fails if the next one is dropped.
  // ---------------------------------------------------------------------------------------------

  @ApiProperty({ type: [WorkflowNodePortResponse], description: 'Declared input ports.' })
  inputs: WorkflowNodePortResponse[];

  @ApiProperty({ type: [WorkflowNodePortResponse], description: 'Declared output ports.' })
  outputs: WorkflowNodePortResponse[];

  @ApiProperty({
    enum: ['on-start', 'per-turn', 'on-end'],
    description: 'WHEN the node runs — orthogonal to lane. on-start once at the opening, per-turn as new material arrives, on-end once at the close.',
  })
  trigger: string;

  @ApiProperty({
    enum: ['realtime', 'durable'],
    description: 'WHICH RUNTIME executes it. realtime carries a latency budget; durable must survive a restart.',
  })
  lane: string;

  @ApiProperty({
    type: [String],
    description: 'Guard attachment keys — node types that must be wired to EVERY INSTANCE of this node before a graph containing it publishes.',
  })
  requires: string[];

  @ApiProperty({
    description: 'Always true for a durable node: Temporal retries activities, and a non-idempotent retry double-writes invisibly.',
  })
  idempotent: boolean;

  @ApiProperty({
    description:
      'The node TYPE’s version. A published node’s ports are never reshaped in place — a breaking change becomes a new key with an @N suffix, and this field agrees with that suffix.',
  })
  schemaVersion: number;

  @ApiPropertyOptional({
    type: WorkflowNodeEvalGateResponse,
    nullable: true,
    description: 'The golden-set eval gate bound to this node type, or null when none is bound.',
  })
  evalGate: WorkflowNodeEvalGateResponse | null;
}

export class WorkflowNodeRegistryResponse {
  @ApiProperty({ type: [WorkflowNodeResponse] })
  nodes: WorkflowNodeResponse[];

  @ApiProperty({ description: 'sha256 of the registry — compared against a published definition’s stamped registryChecksum to detect drift.' })
  registryChecksum: string;
}
