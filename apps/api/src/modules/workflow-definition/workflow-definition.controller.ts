import {
  CloneWorkflowDefinitionRequest,
  CreateWorkflowDefinitionRequest,
  ImportWorkflowDefinitionRequest,
  IWorkflowDefinitionService,
  NodePromptBindingResponse,
  NodePromptUpdateResponse,
  PaginatedQuery,
  PaginatedWorkflowDefinitionResponse,
  PromoteWorkflowToSystemRequest,
  PromoteWorkflowToSystemResponse,
  PublishWorkflowDefinitionRequest,
  SyncWorkflowDefinitionRequest,
  UpdateNodePromptRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionBundle,
  WorkflowDefinitionResponse,
  WorkflowSyncResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IWorkflowExposureService } from '@arcaai/applications';

/** TASK-864 — the one-time secret payload (declared here: the exposure DTOs carry no class for it). */
export class WorkflowWebhookSecretResponseDto {
  @ApiProperty({ description: 'The workflow lineage the secret belongs to.' })
  slug: string;

  @ApiProperty({ description: 'The raw HMAC secret. Shown exactly once — store it now.' })
  secret: string;

  @ApiProperty({ description: 'ISO-8601 rotation instant.' })
  rotatedAt: string;

  @ApiProperty({ description: 'The relative URL external systems POST signed deliveries to.' })
  hookUrl: string;
}
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * WorkflowDefinitionController — admin CRUD + compile/validate/publish for the
 * agentic-workflow-platform substrate, mounted at `/admin/workflow-definitions`
 * (global prefix -> `/api/v1/admin/workflow-definitions`). Mirrors
 * `WorkflowTestFixtureController` (mapper-in-service, If-Match OCC fold on PATCH).
 *
 * Tenancy is service-enforced: the tenant-scope Prisma extension injects `tenantId` from CLS
 * on every read/write of this model (rule 02), and the service additionally asserts tenant
 * ownership on id-scoped operations (cross-tenant id -> 404, never 403 — rule 04).
 *
 * `POST :id/validate` and `POST :id/publish` are NOT versioned PATCH routes — validate is
 * idempotent re-computation (not a CAS: it can run any number of times) and publish is
 * deliberately not a CAS either (`WorkflowDefinitionService.publish`'s doc comment — mirrors
 * `ConsultationContextSchemaService.publish`), so neither carries `@RequiresIfMatch()`.
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-definitions')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:workflow-definition:manage')
@Controller('admin/workflow-definitions')
@CanManage('WorkflowDefinition')
export class WorkflowDefinitionController {
  constructor(
    @Inject(IWorkflowDefinitionService)
    private readonly workflowDefinitionService: IWorkflowDefinitionService,
    // TASK-864 — the webhook secret lives on the exposure plane (it authenticates an invoke).
    @Inject(IWorkflowExposureService)
    private readonly workflowExposureService: IWorkflowExposureService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new DRAFT workflow definition version for the caller tenant' })
  @ApiResponse({ status: 201, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input, or the graph fails shape/engine validation.' })
  @ApiResponse({ status: 409, description: 'maxWorkflowDefinitions quota exceeded.' })
  async create(@Body() request: CreateWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.create(request);
  }

  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s workflow definition versions' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWorkflowDefinitionResponse })
  async fetchAll(@Query() query: PaginatedQuery): Promise<PaginatedWorkflowDefinitionResponse> {
    return this.workflowDefinitionService.list(query);
  }

  // ⚠ DECLARATION ORDER IS LOAD-BEARING: Nest matches routes in declaration order, so this must
  // stay ABOVE `@Get(':id')` — otherwise `:id` swallows `templates` and the library read becomes
  // a 404 lookup of a definition literally named "templates".
  @Get('templates')
  @ApiOperation({
    summary: 'List the platform workflow template library a tenant can clone from',
    description:
      'The SYSTEM tenant’s live published definitions — one row per slug. Read-only and cross-tenant BY DESIGN, ' +
      'bounded to exactly the SYSTEM tenant: another customer tenant’s definitions can never appear here. This is ' +
      'the discovery half of `POST :id/clone`; the two share one predicate, so everything listed here is clonable.',
  })
  @ApiResponse({ status: 200, type: [WorkflowDefinitionResponse] })
  async fetchTemplates(): Promise<WorkflowDefinitionResponse[]> {
    return this.workflowDefinitionService.listTemplates();
  }

  @Post('import')
  @ApiOperation({
    summary: 'Import a workflow bundle as a new DRAFT workflow',
    description:
      'The mirror of `GET :id/export`. Every reference the bundle makes — prompt templates by name, document templates, ' +
      'agents and models by slug, routing by task key — is resolved against YOUR tenant’s catalogue. If any cannot be ' +
      'resolved the whole bundle is refused with a 409 that names them, and nothing is written: a workflow with a missing ' +
      'binding fails at run time, far from whoever could fix it. The graph is then recompiled and validated here, and lands ' +
      'as version 1 of a NEW lineage — DRAFT and inactive, because an import has been reviewed by nobody. Consumes the ' +
      '`maxWorkflowDefinitions` quota exactly as create does.',
  })
  @ApiResponse({ status: 201, type: WorkflowDefinitionResponse })
  @ApiResponse({
    status: 400,
    description: 'Not a workflow bundle, an unimplemented schemaVersion, an unknown palette, or a graph that fails the shape/engine gate.',
  })
  @ApiResponse({
    status: 409,
    description: 'Unresolvable references (`WORKFLOW_IMPORT_UNRESOLVED_REFERENCES`), a targetSlug already in use, or the quota.',
  })
  async import(@Body() request: ImportWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.importDefinition(request);
  }

  // AUTH-NOTE: the class-level `@CanManage('WorkflowDefinition')` UNDERSTATES the real gate here.
  // Writing into SYSTEM is a PLATFORM-ADMIN privilege — "only the platform admin manages SYSTEM"
  // (owner #4) — and there is no "super admin" CASL subject to express it with; tenant admins
  // legitimately hold `manage:WorkflowDefinition` for every other operation on this controller.
  // The real control is `isSuperAdmin` inside `WorkflowDefinitionService.promoteToSystem`, plus
  // the elevated tenant-less context the cross-tenant read/write mechanically requires. That is a
  // PRIVILEGE 403, not the 404-over-403 cross-tenant posture. Never widen this decorator without
  // reading the service first.
  @Post('promote-to-system')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote a workflow from the Global build tenant into the SYSTEM template library',
    description:
      'The platform-admin path of owner decision #4: build in Global (`50000000-…`), promote into SYSTEM (`00000000-…`), ' +
      'which is the template every customer tenant refers to and the tenant template for new tenants. The cross-tenant copy ' +
      'is the existing promotion (`POST admin/agent-promotions`) — prompt templates deep-copied, `evalGate` stripped, a ' +
      'tenant-owned document-template binding blocking, one WORM audit record — and this route adds the half promotion ' +
      'deliberately omits: the SYSTEM row is recompiled against SYSTEM’s own catalogue and PUBLISHED. The previously active ' +
      'SYSTEM version is demoted, never deleted, so the lineage keeps its history. The eval promotion gate runs against the ' +
      'GLOBAL source and defaults to `warn` on this path (owner #7) — set `agentic.eval.promotionGate` to `block` for a ' +
      'blocking gate. Requires a platform administrator and an elevated tenant-less context.',
  })
  @ApiResponse({ status: 200, type: PromoteWorkflowToSystemResponse })
  @ApiResponse({ status: 403, description: 'Not a platform administrator, or the context is not elevated and tenant-less.' })
  @ApiResponse({ status: 404, description: 'The Global build tenant has no such workflow version.' })
  @ApiResponse({ status: 409, description: 'The eval promotion gate failed and is configured to block (`EVAL_GATE_FAILED`).' })
  async promoteToSystem(@Body() request: PromoteWorkflowToSystemRequest): Promise<PromoteWorkflowToSystemResponse> {
    return this.workflowDefinitionService.promoteToSystem(request);
  }

  // AUTH-NOTE: as above, the class-level decorator UNDERSTATES the gate. A sync writes into
  // OTHER tenants, and the real control — the actor holds `manage:WorkflowDefinition` in the
  // source AND in every named target — is enforced imperatively in
  // `WorkflowDefinitionService.syncToTenants`, before any read. Note the deliberate asymmetry it
  // implements: the SOURCE failing is a 403 (a privilege the caller claimed), a TARGET failing is
  // a 404 (so a list of tenant ids can never be used to discover which tenants exist).
  @Post('slug/:slug/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync one workflow version into other tenants you manage',
    description:
      'Owner decision #4: a tenant admin who manages several tenants syncs among their OWN tenants. Each target receives a ' +
      'DRAFT of the SAME lineage — its next version, never published and never active, so a sync can never re-point another ' +
      'tenant’s live consultations. The graph is made portable first and re-resolved against each target’s own catalogue: ' +
      'copying it verbatim would write this tenant’s row ids into another tenant’s workflow. If ANY target cannot resolve a ' +
      'reference the whole sync is refused, naming the tenant — a partial sync leaves an estate nobody can reason about. ' +
      'Requires an elevated tenant-less context.',
  })
  @ApiParam({ name: 'slug', description: 'WorkflowDefinition slug (the lineage key) in the source tenant' })
  @ApiResponse({ status: 200, type: WorkflowSyncResponse })
  @ApiResponse({ status: 400, description: 'A target equals the source, or the source graph references rows that no longer resolve.' })
  @ApiResponse({ status: 403, description: 'No manage rights on the source tenant, or the context is not elevated and tenant-less.' })
  @ApiResponse({ status: 404, description: 'A target tenant the caller does not manage, or no such source version.' })
  @ApiResponse({ status: 409, description: 'A target cannot resolve a reference (`WORKFLOW_SYNC_UNRESOLVED_REFERENCES`).' })
  async sync(@Param('slug') slug: string, @Body() request: SyncWorkflowDefinitionRequest): Promise<WorkflowSyncResponse> {
    return this.workflowDefinitionService.syncToTenants(slug, request);
  }

  // TASK-864 §3.4 — the inbound webhook trigger's secret, issued/rotated per LINEAGE (slug).
  // Declared above `@Get(':id')` for the same declaration-order reason `templates` is.
  @Post('slug/:slug/webhook-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue or rotate the inbound webhook secret for a workflow lineage (returned exactly once)',
    description:
      'Mints the HMAC secret external systems sign `POST /hooks/workflows/{hookId}` deliveries with, and the `hookUrl` they POST to. ' +
      'The raw secret is returned ONCE; only reversible ciphertext is persisted. Rotating invalidates the previous secret immediately. ' +
      'The Trigger node must declare the `webhook` kind for deliveries to be accepted.',
  })
  @ApiParam({ name: 'slug', description: 'WorkflowDefinition slug (the lineage key)' })
  @ApiResponse({ status: 200, type: WorkflowWebhookSecretResponseDto })
  @ApiResponse({ status: 404, description: 'No published version of this slug in the caller`s tenant (or cross-tenant).' })
  async rotateWebhookSecret(@Param('slug') slug: string): Promise<WorkflowWebhookSecretResponseDto> {
    return this.workflowExposureService.rotateWebhookSecret(slug);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one workflow definition version' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.getById(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'List every version row in this definition’s (tenantId, slug) lineage, most recent first' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: [WorkflowDefinitionResponse] })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async fetchVersions(@Param('id') id: string): Promise<WorkflowDefinitionResponse[]> {
    return this.workflowDefinitionService.listVersions(id);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a DRAFT workflow definition version (If-Match OCC)',
    description:
      'Sparse patch. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and ' +
      "CAS'es against the row `_version`; drift → 412, missing header → 428. Rejected 400 if the row is " +
      'PUBLISHED/DEPRECATED (branch a new draft instead), or if a replaced `graph` fails shape/engine validation.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateWorkflowDefinitionRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WorkflowDefinitionResponse> {
    const effectiveRequest: UpdateWorkflowDefinitionRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.workflowDefinitionService.update(id, effectiveRequest);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a workflow definition version' })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.deleteById(id);
  }

  @Post(':id/clone')
  @ApiOperation({
    summary: 'Clone an existing workflow (or a platform template) into a NEW draft workflow',
    description:
      'Seeds a NEW `(tenantId, slug)` lineage — `versionNumber` 1, DRAFT, inactive — from the source ' +
      'definition’s graph. This is NOT `POST /` with a `parentVersionId`: that branches a new version INSIDE the ' +
      'source’s slug. A `targetSlug` this tenant already uses is rejected 409 rather than silently becoming ' +
      'version N+1 of that lineage.\n\n' +
      'Clonable sources are the caller tenant’s own definitions (any status) and the SYSTEM tenant’s live ' +
      'published templates (`GET /templates`). Any other tenant’s id is a 404, indistinguishable from a miss.\n\n' +
      'The graph is copied verbatim; `compiledConfig` and its checksums, `publishedAt`, `isActive` and `tags` are ' +
      'NOT carried over, and the validation report is recomputed for this tenant against the current node ' +
      'registry. Consumes the `maxWorkflowDefinitions` quota exactly as create does.',
  })
  @ApiParam({ name: 'id', description: 'Source WorkflowDefinition id — the caller’s own row, or a SYSTEM template.' })
  @ApiResponse({ status: 201, type: WorkflowDefinitionResponse })
  @ApiResponse({
    status: 400,
    description: 'The source graph fails shape/engine validation, or a SYSTEM template pins prompt/document catalog rows this tenant cannot resolve.',
  })
  @ApiResponse({ status: 404, description: 'Source not found (or another tenant’s).' })
  @ApiResponse({ status: 409, description: 'targetSlug is already in use by this tenant, or the maxWorkflowDefinitions quota is exceeded.' })
  async clone(@Param('id') id: string, @Body() request: CloneWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.clone(id, request);
  }

  @Get(':id/export')
  @ApiOperation({
    summary: 'Export one workflow version as a portable JSON bundle',
    description:
      'Owner decision #4 — tenant admins export/import workflows as JSON. The bundle carries VALUES ONLY: the authored ' +
      'definition, its node configuration, and its catalogue bindings expressed as PORTABLE KEYS (prompt template by name, ' +
      'document template / agent / model by slug, routing by task key). It carries NO row id (they are meaningless in ' +
      'another tenant), NO credential, and NO `evalGate` — a `goldenSetId` names a corpus of encrypted PHI, so not even the ' +
      'pointer leaves the tenant. The derived `compiledConfig` and validation report are not exported either: they are ' +
      'recomputed on import against the importing tenant’s registry and rule set.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionBundle })
  @ApiResponse({ status: 400, description: 'The graph references a row that no longer resolves, so the export would silently lose the binding.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async export(@Param('id') id: string): Promise<WorkflowDefinitionBundle> {
    return this.workflowDefinitionService.exportDefinition(id);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-run shape + engine + DRAFT rule-catalogue validation and persist the report',
    description:
      'Advances DRAFT -> VALIDATED when the engine gate (shape + compile()) is clean. DRAFT rule-catalogue ' +
      'findings (’s not-yet-clinically-reviewed rules) are recorded on the report but never block this.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Row is PUBLISHED/DEPRECATED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async validate(@Param('id') id: string): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.validate(id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile the graph and publish this version',
    description:
      'Rejected 400 if the engine gate is not clean (a cycle, an unregistered node type, or malformed shape) — ' +
      'the sole publish-blocking predicate; DRAFT rule-catalogue findings never block publish. `activate` ' +
      '(default true) makes this the version the dispatcher resolves for new runs, demoting the slug’s previous ' +
      'active version. Once published (and WORKFLOW_EXPOSURE_ENABLED), this version becomes invokable through ' +
      'the public exposure plane (`POST /workflows/:slug/invoke`) — if its resolved AI task default (e.g. ' +
      '`smr.finalize`, set under AI Task Defaults) selects a cloud provider, public invocations send this ' +
      "tenant's data to that vendor. Public exposure does NOT restrict provider choice ( R-4 owner " +
      'ruling, 2026-08-20): the tenant carries that risk.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: WorkflowDefinitionResponse })
  @ApiResponse({ status: 400, description: 'Row is PUBLISHED/DEPRECATED, or the graph cannot be compiled.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishWorkflowDefinitionRequest): Promise<WorkflowDefinitionResponse> {
    return this.workflowDefinitionService.publish(id, request ?? {});
  }

  // ============================================================
  // DD-11 — prompt binding
  // ============================================================

  @Get(':id/prompt-bindings')
  @ApiOperation({
    summary: 'Which prompt version each node is pinned to, and whether a newer one exists',
    description:
      'The "new version available" affordance. Editing a prompt template from the Prompt management screen ' +
      'creates a new version and deliberately moves NO node’s pin — that is what stops a shared template from ' +
      'silently changing every workflow that references it. This read is the other half of that guarantee: it ' +
      'makes "this node is behind" visible so it can be re-pinned deliberately, per node. An UNPINNED node is ' +
      'not reported as behind — following the template is a legitimate choice.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiResponse({ status: 200, type: NodePromptBindingResponse, isArray: true })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async listPromptBindings(@Param('id') id: string): Promise<NodePromptBindingResponse[]> {
    return this.workflowDefinitionService.listPromptBindings(id);
  }

  @Put(':id/nodes/:nodeId/prompt')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Edit a node’s prompt from within the node: mint a new version if the content changed, and move this node’s pin',
    description:
      'One of DD-11’s TWO update paths, and the only one that moves a pin. When `content` (and `variables`) ' +
      'differ from the template’s latest version, both writes happen in a single transaction: a new immutable ' +
      '`PromptVersion` is minted and THIS node’s `promptVersionNumber` is moved to it. Splitting them would ' +
      'leave either a version nothing points at, or a pin naming a version that was never created. Other nodes ' +
      'bound to the same template are untouched.\n\n' +
      'ADOPTING is not authoring: when the submitted content is byte-identical to the template’s latest ' +
      'version, NOTHING is minted — the pin simply moves to that existing version, and the shared template head ' +
      'is left alone. Because an out-of-band template edit deliberately moves no pin, adoption is the COMMON ' +
      'path, and minting a duplicate on each one made the version list unreadable exactly where an admin goes ' +
      'to read it. Read `promptVersionMinted` on the response to tell the two outcomes apart.\n\n' +
      'Only a DRAFT/VALIDATED definition may be edited — a PUBLISHED graph is immutable, so re-pointing a ' +
      'published workflow’s prompt means branching a new draft. `If-Match` (RFC 7232) is REQUIRED, and is ' +
      'checked on BOTH branches: an unchanged body never buys a stale client a silent 200.',
  })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the workflow definition version the client read.', required: true })
  @ApiParam({ name: 'id', description: 'WorkflowDefinition id' })
  @ApiParam({ name: 'nodeId', description: 'Graph node id. Must carry `promptTemplateId`.' })
  @ApiResponse({ status: 200, type: NodePromptUpdateResponse })
  @ApiResponse({ status: 400, description: 'Row is PUBLISHED/DEPRECATED, or the node references no prompt template.' })
  @ApiResponse({ status: 404, description: 'Definition or template not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'If-Match is stale — the definition changed since the client read it.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async updateNodePrompt(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body() request: UpdateNodePromptRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<NodePromptUpdateResponse> {
    // Header takes precedence over the body when both are present — the house
    // precedence (`department.controller.ts#update`).
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.workflowDefinitionService.updateNodePrompt(id, nodeId, effective);
  }
}
