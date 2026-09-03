/**
 * Types for the `WorkflowDefinition` / node-registry surface, mirrored field-for-field off the
 * DELIVERED DTOs — not an assumption. Sources:
 *   - `packages/applications/src/services/workflow-definition/dto/workflow-definition.response.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/create-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/update-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/publish-workflow-definition.request.ts`
 *   - `packages/applications/src/services/workflow-definition/dto/workflow-node.response.ts`
 * See the registry and definition-api contracts
 * for the re-derivation notes (`file:line` citations, what changed vs. the earlier plan).
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

/**
* `POST admin/workflow-definitions/:id/clone`. Deliberately carries NO `graph` or
 *  `paletteKey`: both are derived server-side from the source row, so a caller can never pair
 *  one definition's provenance with another definition's bytes. 
 */
export interface CloneWorkflowDefinitionRequest {
  targetSlug: string;
  name?: string;
  description?: string;
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

/**
 * The closed workflow port type vocabulary — mirrored, not imported, for the
 * same reason the rest of this file mirrors `@arcaai/workflow-contract` (see the module
 * comment above): the console never bundles that package at runtime. Source of truth:
 * `packages/workflow-contract/src/port-model.ts`'s `WORKFLOW_PORT_PRIMITIVES`.
 */
export type WorkflowPortPrimitive =
  | 'control'
  | 'stream<audio>'
  | 'audio'
  | 'transcript'
  | 'text'
  | 'object'
  | 'entities'
  | 'document'
  | 'edits'
  | 'verdict'
  | 'context<schemaRef>';

/** One declared port on a node type (`WorkflowNodePortResponse`) — what
 *  `lib/port-compatibility.ts`'s connection predicate checks. */
export interface WorkflowNodePort {
  name: string;
  primitive: WorkflowPortPrimitive;
  required: boolean;
  multiple: boolean;
}

/**
* `WorkflowNodeDescriptor`'s wire projection (`WorkflowNodeResponse`). No `label` field yet
 *  (registry.contract.md) — the Studio still derives a display label from `type`
 *  (`humanizeKey`). `configSchema` IS now on the delivered DTO (registry.contract.md's
 * resolution path #1: " adds a `configSchema` field… when it adds real palette node
 *  types") — `null` for a node type with no authored schema yet, a real, structural state the
 *  inspector's raw-JSON fallback already handles as `undefined` (see
 *  `components/workflow-studio-editor.tsx`).
 *
 * `inputs`/`outputs` are the only other newly-delivered fields mirrored
 *  here — `trigger`/`lane`/`requires`/`idempotent`/`schemaVersion`/`evalGate` also landed on
 *  the wire DTO but have no Studio consumer yet, so they are left unmirrored rather than added
 *  speculatively; add them, hand-mirrored the same way, when a task actually reads them. 
 */
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
  /** Declared input ports. */
  inputs: readonly WorkflowNodePort[];
  /** Declared output ports. */
  outputs: readonly WorkflowNodePort[];
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
 * half (a) — WHICH workflow definition governs a tenant or department for a palette.
 * Mirrors `WorkflowAssignmentResponse`
 * (`packages/applications/src/services/workflow-assignment/dto/workflow-assignment.response.ts`)
 * field-for-field. Only `TENANT` and `DEPARTMENT` scope are writable from this admin surface —
 * `DOCTOR` is structurally supported by the cascade but is not a product decision anyone has made
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

// ---------------------------------------------------------------------------
// DD-11 — prompt binding.
//
// A node references a prompt TEMPLATE (`promptTemplateId`) and, optionally,
// pins one immutable VERSION of it (`promptVersionNumber`). Two update paths
// exist and they behave differently ON PURPOSE:
//
//   in-node edit -> mint a new PromptVersion AND move THIS node's pin, atomically
//   Prompt screen -> mint a new PromptVersion and move NO node's pin
//
// The second is what stops one shared template silently re-prompting every
// workflow that references it — including published clinical ones. Its cost is
// that a node can fall behind invisibly, which is what `hasNewVersion` exists
// to surface.
// ---------------------------------------------------------------------------

/** One node's prompt binding, plus whether a newer version of its template exists. */
export interface NodePromptBinding {
  nodeId: string;
  nodeType: string;
  promptTemplateId: string;
  promptTemplateName: string | null;
  /** The node's OWN pin. Null = unpinned: the node follows the template, which is a legitimate choice. */
  pinnedVersionNumber: number | null;
  /** The highest version number the template currently has. */
  latestVersionNumber: number | null;
  /**
   * True only when the node IS pinned and the template has moved past that pin.
   * An unpinned node is never reported as behind — reporting it would train
   * admins to ignore the signal.
   */
  hasNewVersion: boolean;
}

/**
 * `PUT :id/nodes/:nodeId/prompt` — DD-11's in-node edit, the ONLY path that
 * moves a pin.
 *
 * Deliberately not a "set the pin" request: `content` is required because the
 * server decides from it whether this is an AUTHORING act or an ADOPTION.
 * `promptVersionNumber` is absent by design — it is server-stamped, and the
 * gateway's `forbidNonWhitelisted` pipe would reject a submitted one.
 */
export interface UpdateNodePromptRequest {
  content: string;
  changeReason?: string;
  variables?: Record<string, unknown>;
  /** OCC version of the WORKFLOW DEFINITION; the `If-Match` header overrides it. */
  expectedVersion?: number;
}

/**
 * The answer to that PUT — a SUPERSET of `WorkflowDefinition`, not a wrapper around it
 * (`NodePromptUpdateResponse` in `@arcaai/applications`), so the definition is still read
 * straight off the body.
 *
 * The three extra fields exist because the call is no longer always a mint.
 * Content byte-identical to the template's LATEST version moves the pin and creates nothing;
 * a node already pinned there is a true no-op — no graph write, no `_version` bump, no
 * sys-event. Since DD-11 PATH 2 deliberately leaves node pins alone when a template is edited
 * out of band, adoption is the COMMON path through the in-node editor, so a client that
 * reported "minted v6" on every save would be wrong most of the time — and specifically wrong
 * about whether an immutable clinical artifact was created. Read the outcome here; never
 * predict it from `latestVersionNumber + 1`.
 */
export interface NodePromptUpdateResult extends WorkflowDefinition {
  /** False when the submitted content matched the latest version and the pin was simply moved. */
  promptVersionMinted: boolean;
  /** The version this node is pinned to AFTER the request. */
  promptVersionNumber: number;
  /** The pin BEFORE the request; `null` when the node was unpinned. Equal to
   *  `promptVersionNumber` when the request changed nothing at all. */
  previousPromptVersionNumber: number | null;
}

/** One immutable version of a prompt template (`admin/prompt-templates/:id/versions`). */
export interface PromptTemplateVersion {
  id: string;
  versionNumber: number;
  content: string;
  changeReason?: string | null;
  createdAt?: string;
}
