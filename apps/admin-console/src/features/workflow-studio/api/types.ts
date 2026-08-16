/**
 * Types for the `WorkflowDefinition` / node-registry surface, mirrored field-for-field off the
 * DELIVERED (TASK-734) DTOs — not an assumption. Sources:
 *   - `packages/applications/src/services/workflow-definition/dto/workflow-definition.response.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/create-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/update-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/publish-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/workflow-node.response.ts`
 * See `docs/implementation/TASK-719-Workflow-Studio-V1/contracts/{registry,definition-api}.contract.md`
 * for the re-derivation notes (`file:line` citations, what changed vs. the pre-TASK-734 plan).
 *
 * The console never imports `@arcaai/workflow-contract` at runtime (it is the server
 * validator's engine, not a browser artifact — validation-report.contract.md) — these types are
 * a hand-mirrored, browser-side copy of the wire shape.
 */

export type WorkflowDefinitionStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DEPRECATED';

/** `WorkflowGraph` (`@arcaai/workflow-contract`'s `graph-model.ts`) — the canvas graph exactly
 *  as authored. `WorkflowGraphNode` has NO `position` field (registry.contract.md /
 *  definition-api.contract.md: confirmed, not guessed) — the Studio nests client-side layout
 *  under the Studio-reserved `config.__position` key at the serialization boundary; see
 *  `lib/graph-serialization.ts`. */
export interface WorkflowGraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface WorkflowGraphEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/** Mirrors `@arcaai/workflow-contract`'s `report.ts` (validation-report.contract.md — the one
 *  contract with a solid, delivered floor). */
export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';
export type WorkflowRuleClass = 'structural' | 'invariant' | 'schema';

export interface WorkflowFinding {
  ruleId: string;
  ruleClass: WorkflowRuleClass;
  severity: WorkflowFindingSeverity;
  nodeId: string | null;
  edgeId?: string;
  path?: string;
  message: string;
  registerRefs?: readonly string[];
}

export interface WorkflowValidationReport {
  reportVersion: 1;
  ok: boolean;
  findings: WorkflowFinding[];
  ruleSetVersion: number;
  registryChecksum: string;
  evaluatedAt: string;
}

export interface WorkflowDefinition {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  paletteKey: string;
  versionNumber: number;
  parentVersionId: string | null;
  status: WorkflowDefinitionStatus;
  graph: WorkflowGraph;
  graphChecksum: string;
  compiledConfig: Record<string, unknown> | null;
  compiledConfigChecksum: string | null;
  registryChecksum: string | null;
  validationReport: WorkflowValidationReport | null;
  /** True when a PUBLISHED row is out of sync with the running node registry (checksum drift). */
  needsReview: boolean;
  validatedAt: string | null;
  publishedAt: string | null;
  deprecatedAt: string | null;
  /** The movable pointer: the version the dispatcher resolves for new runs. */
  isActive: boolean;
  resourceStatus: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency version (`_version`) — mirrored by the response `ETag`. */
  version: number;
  tags: string[];
}

export interface CreateWorkflowDefinitionRequest {
  slug: string;
  name: string;
  description?: string;
  paletteKey: string;
  graph: WorkflowGraph;
  parentVersionId?: string;
}

/** No `paletteKey` — set once at create, never edited (confirmed absent from the delivered DTO). */
export interface UpdateWorkflowDefinitionRequest {
  name?: string;
  description?: string;
  graph?: WorkflowGraph;
  expectedVersion?: number;
}

export interface PublishWorkflowDefinitionRequest {
  activate?: boolean;
}

/** `WorkflowNodeDescriptor`'s wire projection (`WorkflowNodeResponse`). No `label`, no
 *  `configSchema` — neither field exists on the delivered DTO (registry.contract.md). */
export interface WorkflowNodeDescriptor {
  type: string;
  implemented: boolean;
  activityName: string;
  classes: readonly string[];
  paletteKey: string | null;
  critical: boolean;
  externalWrite: boolean;
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
}

export interface WorkflowNodeRegistry {
  nodes: WorkflowNodeDescriptor[];
  registryChecksum: string;
}
