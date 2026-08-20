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
 *  as authored. `WorkflowGraphNode.position` is a first-class, optional sibling of `config`
 *  (definition-api.contract.md's "no `position` field" gap, closed) — client-authored canvas
 *  layout, never read by the compiler/interpreter. `lib/graph-serialization.ts` still reads the
 *  legacy `config.__position` nesting as a fallback for a graph saved before this field existed,
 *  but never writes it again. */
export interface WorkflowGraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
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

/** `WorkflowNodeDescriptor`'s wire projection (`WorkflowNodeResponse`). No `label` field yet
 *  (registry.contract.md) — the Studio still derives a display label from `type`
 *  (`humanizeKey`). `configSchema` IS now on the delivered DTO (registry.contract.md's
 *  resolution path #1: "TASK-720 adds a `configSchema` field… when it adds real palette node
 *  types") — `null` for a node type with no authored schema yet, a real, structural state the
 *  inspector's raw-JSON fallback already handles as `undefined` (see
 *  `components/workflow-studio-editor.tsx`). */
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
  configSchema: Record<string, unknown> | null;
}

export interface WorkflowNodeRegistry {
  nodes: WorkflowNodeDescriptor[];
  registryChecksum: string;
}

/** Minimal prompt-template shape for the inspector's picker (id + name). Mirrors
 *  `features/departments/api/types.ts`'s `PromptTemplateOption` field-for-field — deliberately
 *  NOT imported from there (rule 13 §Structure: "features never import each other"). */
export interface PromptTemplateOption {
  id: string;
  name: string;
}

/**
 * TASK-733 half (a) — WHICH workflow definition governs a tenant or department for a palette.
 * Mirrors `WorkflowAssignmentResponse`
 * (`packages/applications/src/services/workflow-assignment/dto/workflow-assignment.response.ts`)
 * field-for-field. Only `TENANT` and `DEPARTMENT` scope are writable from this admin surface —
 * `DOCTOR` is structurally supported by the cascade but is not a product decision anyone has made
 * (ticket §1.4).
 */
export type WorkflowAssignmentScope = 'TENANT' | 'DEPARTMENT';

export interface WorkflowAssignment {
  id: string;
  tenantId: string;
  scope: WorkflowAssignmentScope;
  scopeId: string | null;
  paletteKey: string;
  workflowDefinitionSlug: string;
  createdAt: string;
  updatedAt: string;
  /** OCC row version — echoed back as If-Match/`expectedVersion` on PATCH/DELETE. */
  version: number;
}

/** POST/PATCH body (`UpsertWorkflowAssignmentRequest`). PATCH has no `:id` — the controller
 *  identifies the row by the `(scope, scopeId, paletteKey)` tuple in the body. */
export interface UpsertWorkflowAssignmentRequest {
  scope: WorkflowAssignmentScope;
  scopeId?: string | null;
  paletteKey: string;
  workflowDefinitionSlug: string;
  /** Recorded verbatim on the WORM `WorkflowAssignmentChange` row. */
  reason?: string;
  expectedVersion?: number;
}

/** Minimal department shape for the assignment matrix's row list (id + name/code). Mirrors
 *  `features/departments/api/types.ts`'s `Department` field-for-field for the subset used here —
 *  deliberately NOT imported from there (rule 13 §Structure: "features never import each other"). */
export interface DepartmentOption {
  id: string;
  name?: string;
  code?: string;
  resourceStatus?: 'ENABLED' | 'DISABLED';
}
