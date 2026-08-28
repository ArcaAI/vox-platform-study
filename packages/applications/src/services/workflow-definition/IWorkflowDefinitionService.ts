import { PaginatedQuery } from '../../common';
import {
  CreateWorkflowDefinitionRequest,
  NodePromptBindingResponse,
  NodePromptUpdateResponse,
  PaginatedWorkflowDefinitionResponse,
  PublishWorkflowDefinitionRequest,
  SandboxCompileResult,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
  WorkflowNodeRegistryResponse,
} from './dto';

/**
 * `WorkflowDefinition` CRUD + the compile/validate/publish lifecycle (TASK-734, closing the
 * gap TASK-716's own README §2.3 named: "`IWorkflowValidatorService` port + stub" was never
 * built — this service calls `@arcaai/workflow-contract`'s `validate`/`compile` directly
 * rather than through a speculative port nothing else consumes).
 *
 * A row IS a version (`workflow-definition.prisma`'s file header) — `create` mints a new DRAFT
 * row (`versionNumber = max + 1` for the slug, inside a transaction); `update` is a versioned
 * PATCH on that SAME DRAFT row; `publish` transitions it to PUBLISHED in place (no new row) —
 * a NEW row is only created by a later `create` that branches from it via `parentVersionId`.
 */
export interface IWorkflowDefinitionService {
  list(query: PaginatedQuery): Promise<PaginatedWorkflowDefinitionResponse>;

  /** Cross-tenant id throws `NotFoundException` (404-over-403). */
  getById(id: string): Promise<WorkflowDefinitionResponse>;

  /**
   * Every version row for `id`'s `(tenantId, slug)` lineage, most recent first — TASK-719's
   * `GET admin/workflow-definitions/:id/versions` (`definition-api.contract.md`). Cross-tenant
   * id throws `NotFoundException`.
   */
  listVersions(id: string): Promise<WorkflowDefinitionResponse[]>;

  /**
   * Creates a new DRAFT row. Rejects (400) a graph that fails shape validation or that
   * `compile()` cannot turn into a `compiledConfig` (a cycle, an unregistered node type) — the
   * ENGINE gate. DRAFT clinical-rule-catalogue findings (TASK-716's 22 not-yet-clinically-
   * reviewed rules) are recorded on `validationReport` but never block create (decision #3).
   */
  create(dto: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /**
   * Versioned PATCH (`If-Match`/`expectedVersion`). Throws `BadRequestException` on a
   * PUBLISHED/DEPRECATED row (`assertMutable`) — those are hard-immutable by service
   * convention (`workflow-definition.prisma` §3.4). A `graph` change re-runs the same
   * shape+engine gate as `create`.
   */
  update(id: string, dto: UpdateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /** Soft delete. Does not touch sibling versions of the same slug. */
  deleteById(id: string): Promise<WorkflowDefinitionResponse>;

  /**
   * Re-runs shape + engine + the DRAFT rule catalogue against the row's current `graph` and
   * persists the fresh `WorkflowValidationReport` (never swallowed). Advances DRAFT ->
   * VALIDATED when the engine gate is clean (DRAFT rule findings never block this transition —
   * decision #3). Throws `BadRequestException` on a PUBLISHED/DEPRECATED row.
   */
  validate(id: string): Promise<WorkflowDefinitionResponse>;

  /**
   * Compiles the graph into `compiledConfig` (stamping `compiledConfigChecksum` and the
   * CURRENT `registryChecksum`) and transitions the row to PUBLISHED. Throws
   * `BadRequestException` if the engine gate is not clean (a cycle, an unregistered node type,
   * or malformed shape) — the sole publish-blocking predicate; DRAFT rule-catalogue findings
   * never block this. `dto.activate` (default true) also demotes the slug's previously ACTIVE
   * version, mirroring `ConsultationContextSchema.isDefault`'s "at most one true per key".
   */
  publish(id: string, dto: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /** Read-only projection of `WORKFLOW_NODE_REGISTRY` — no tenant scoping, no table. */
  listNodes(): Promise<WorkflowNodeRegistryResponse>;

  /**
   * Compile `id`'s CURRENT graph fresh, for a Workbench sandbox test run (TASK-721). Unlike
   * `publish()`, this works on a DRAFT/VALIDATED row too and never persists the result — it is
   * a read, not a lifecycle transition. Throws `BadRequestException` (400) if the engine gate
   * is not clean (same predicate `publish()` uses); cross-tenant/unknown `id` throws
   * `NotFoundException` (404-over-403).
   */
  getCompiledConfigForSandboxRun(id: string): Promise<SandboxCompileResult>;

  /**
   * DD-11 PATH 1 — edit a node's prompt FROM WITHIN THE NODE: mint a new
   * `PromptVersion` and move THAT node's pin to it, atomically.
   *
   * ADOPTING is not authoring (§7b item 1). When `content` (+ `variables`) is
   * byte-identical to the template's LATEST version, NOTHING is minted: the
   * node's pin simply moves to that existing version. `promptVersionMinted` on
   * the response is how a caller tells the two outcomes apart — adoption is the
   * common path under DD-11, and minting a duplicate on each one made the
   * version list unreadable exactly where an admin goes to read it.
   *
   * The sibling path — editing the same template from the Prompt management
   * screen (`IPromptManagementService.updatePromptTemplate`) — creates a
   * version and moves NO node's pin. That asymmetry is the feature: it is what
   * stops a shared template from silently changing every workflow that
   * references it.
   *
   * @throws NotFoundException — unknown/cross-tenant definition or template
   * @throws BadRequestException — PUBLISHED/DEPRECATED row, or a node with no
   *   `promptTemplateId`
   * @throws OptimisticConcurrencyException — stale `expectedVersion`/`If-Match`,
   *   on BOTH branches: the precondition is evaluated before the mint/adopt
   *   decision, so an unchanged body never buys a stale client a silent 200
   */
  updateNodePrompt(id: string, nodeId: string, dto: UpdateNodePromptRequest): Promise<NodePromptUpdateResponse>;

  /**
   * DD-11 — every node's prompt binding plus whether its template has a newer
   * version. The "new version available" affordance; the necessary complement
   * to a pin that out-of-band edits deliberately never move.
   */
  listPromptBindings(id: string): Promise<NodePromptBindingResponse[]>;
}

export const IWorkflowDefinitionService = Symbol('IWorkflowDefinitionService');
