import { PaginatedQuery } from '../../common';
import {
  CloneWorkflowDefinitionRequest,
  CreateWorkflowDefinitionRequest,
  ImportWorkflowDefinitionRequest,
  NodePromptBindingResponse,
  NodePromptUpdateResponse,
  PaginatedWorkflowDefinitionResponse,
  PromoteWorkflowToSystemRequest,
  PromoteWorkflowToSystemResponse,
  PublishWorkflowDefinitionRequest,
  SandboxCompileResult,
  SyncWorkflowDefinitionRequest,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionBundle,
  WorkflowDefinitionResponse,
  WorkflowNodeRegistryResponse,
  WorkflowSyncResponse,
} from './dto';

/**
 * `WorkflowDefinition` CRUD + the compile/validate/publish lifecycle (closing the
 * gap own named: "`IWorkflowValidatorService` port + stub" was never
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
   * Every version row for `id`'s `(tenantId, slug)` lineage, most recent first
   * `GET admin/workflow-definitions/:id/versions` (`definition-api.contract.md`). Cross-tenant
   * id throws `NotFoundException`.
   */
  listVersions(id: string): Promise<WorkflowDefinitionResponse[]>;

  /**
   * Creates a new DRAFT row. Rejects (400) a graph that fails shape validation or that
   * `compile()` cannot turn into a `compiledConfig` (a cycle, an unregistered node type) — the
   * ENGINE gate. DRAFT clinical-rule-catalogue findings ( 22 not-yet-clinically-
   * reviewed rules) are recorded on `validationReport` but never block create (decision #3).
   */
  create(dto: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /**
   * seed a NEW workflow (new `(tenantId, slug)` lineage, `versionNumber` 1, DRAFT)
   * from an existing definition's graph.
   *
   * This is NOT `create` with a `parentVersionId`: that branches a new version INSIDE the
   * source's slug, and the clone deliberately gets its own. The distinction is enforced, not
   * documented — a `targetSlug` the tenant already uses is a `ConflictException`, because
   * `create`'s `max(versionNumber) + 1` mint would otherwise turn a clone into version N+1 of a
   * lineage that may be published and serving traffic.
   *
   * Clonable sources are the caller tenant's own definitions (any status) and the SYSTEM
   * tenant's live published templates — see `WorkflowDefinitionRepository.findCloneSource`.
   *
   * The graph is copied VERBATIM; every publish artifact (`compiledConfig` + both checksums,
   * `publishedAt`, `isActive`, `tags`) is dropped, and `validationReport`/`graphChecksum` are
   * RECOMPUTED for the destination tenant rather than carried over — a report produced under
   * another tenant's rules or an older node registry is a stale claim about a graph that now
   * lives somewhere else.
   *
   * @throws NotFoundException — unknown, soft-deleted, or another tenant's id (404-over-403)
   * @throws ConflictException — `targetSlug` is already in use by this tenant
   * @throws BadRequestException — the source graph fails the shape/engine gate, or a SYSTEM
   *   template pins a `promptTemplateId`/`documentTemplateId` (a row id the destination tenant
   *   cannot resolve — those catalogs are per-tenant clones with different ids, and neither is
   *   a SYSTEM-shared read)
   * @throws QuotaExceededException — `maxWorkflowDefinitions`, on the same precheck as `create`
   */
  clone(sourceId: string, dto: CloneWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /**
   * the platform template library a tenant may clone from: the SYSTEM tenant's live
   * published definitions. Read-only and cross-tenant BY DESIGN, bounded to exactly the SYSTEM
   * tenant; a customer tenant's rows can never appear here.
   */
  listTemplates(): Promise<WorkflowDefinitionResponse[]>;

  /**
   * Versioned PATCH (`If-Match`/`expectedVersion`). Throws `BadRequestException` on a
   * PUBLISHED/DEPRECATED row (`assertMutable`) — those are hard-immutable by service
   * convention (`workflow-definition.prisma` A `graph` change re-runs the same
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

  /**
   * TASK-885 (owner #4) — export ONE version as a portable JSON bundle.
   *
   * VALUES ONLY: the authored definition, its node configs, and its catalogue bindings expressed
   * as PORTABLE KEYS (prompt template by name, document template / agent / model by slug, routing
   * by task key). Never a row id, never a credential, never `evalGate` (a `goldenSetId` names a
   * corpus of encrypted PHI). The derived `compiledConfig` / `validationReport` are not exported
   * — they are recomputed on import against the importing tenant's registry and rule set.
   *
   * @throws NotFoundException — unknown, soft-deleted, or another tenant's id (404-over-403)
   * @throws BadRequestException — the graph references a row that no longer resolves, so the
   *   export cannot be taken without silently losing the binding
   */
  exportDefinition(id: string): Promise<WorkflowDefinitionBundle>;

  /**
   * TASK-885 (owner #4) — import a bundle into the caller's tenant as a NEW DRAFT lineage.
   *
   * Every reference is resolved against the CALLER's visible catalogue. If ANY cannot be
   * resolved the whole bundle is refused with a 409 naming every one — never a partial import,
   * never a silently dropped binding.
   *
   * @throws BadRequestException — wrong `kind`, unimplemented `schemaVersion`, unknown palette,
   *   or a graph that fails the shape/engine gate
   * @throws ConflictException — unresolvable references (`WORKFLOW_IMPORT_UNRESOLVED_REFERENCES`),
   *   a `targetSlug` already in use, or the `maxWorkflowDefinitions` quota
   */
  importDefinition(dto: ImportWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse>;

  /**
   * TASK-885 (owner #4) — sync ONE version into other tenants the caller ALREADY manages.
   *
   * Requires an elevated tenant-less context, and `manage:WorkflowDefinition` in the source
   * (missing ⇒ 403) and in EVERY target (missing ⇒ **404**, so the request can never be used to
   * discover which tenants exist). Each target receives a DRAFT whose references were resolved
   * against ITS catalogue and whose report was recomputed against ITS rule set; a target that
   * already has the lineage gets its NEXT version. All-or-nothing.
   *
   * @throws ForbiddenException — not elevated/tenant-less, or no manage on the source
   * @throws NotFoundException — a target the caller does not manage, or no such source version
   * @throws ConflictException — a target cannot resolve a reference (`WORKFLOW_SYNC_UNRESOLVED_REFERENCES`)
   */
  syncToTenants(slug: string, dto: SyncWorkflowDefinitionRequest): Promise<WorkflowSyncResponse>;

  /**
   * TASK-885 (owner #4) — promote a workflow from the Global build tenant into SYSTEM and
   * publish it as the platform template. Super-admin only (403 otherwise); the prior SYSTEM
   * version is demoted, never deleted, so the lineage keeps its history.
   *
   * @throws ForbiddenException — not a platform administrator, or not elevated and tenant-less
   * @throws NotFoundException — Global has no such workflow version
   * @throws ConflictException — the eval promotion gate blocked (`EVAL_GATE_FAILED`)
   */
  promoteToSystem(dto: PromoteWorkflowToSystemRequest): Promise<PromoteWorkflowToSystemResponse>;

  /** Read-only projection of `WORKFLOW_NODE_REGISTRY` — no tenant scoping, no table. */
  listNodes(): Promise<WorkflowNodeRegistryResponse>;

  /**
   * Compile `id`'s CURRENT graph fresh, for a Workbench sandbox test run. Unlike
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
   * ADOPTING is not authoring. When `content` (+ `variables`) is
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
