import {
  AgentBundleResponse,
  AgentResponse,
  ListAgentLineagesQuery,
  PaginatedAgentLineageResponse,
  AgentSyncResponse,
  AgentTask,
  AgentTestAckResponse,
  AgentTestResultResponse,
  CloneAgentRequest,
  CreateAgentRequest,
  FinalizeAgentTestRequest,
  IAgentService,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  SyncAgentRequest,
  TestAgentRequest,
  UpdateAgentRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';

/**
 * AgentAdminController — the Agent authoring lifecycle (TASK-863 §3.3), mounted at
 * `/admin/agents` (global prefix -> `/api/v1/admin/agents`). Mirrors
 * `WorkflowDefinitionController`: mapper-in-service, If-Match OCC fold on PATCH.
 *
 * Tenancy is service-enforced: rows are SYSTEM-shared-read (a tenant SEES the platform's
 * published agents as templates) but every write asserts ownership — a foreign id, and a
 * SYSTEM row for a tenant admin, both answer 404 (404-over-403, rule 04).
 *
 * `POST :id/validate` / `:id/publish` / `:id/deprecate` are state transitions, not CAS
 * writes, so they carry no `@RequiresIfMatch()` (the WorkflowDefinition call).
 *
 * TASK-884 adds four PORTABILITY routes addressed by the lineage SLUG rather than a row id
 * (`import`, `:slug/export`, `:slug/clone`, `:slug/sync`), because a slug is what a person
 * holds: it is stable across versions and it is what an exported file, a console link and
 * another tenant all name. Two of them carry an `AUTH-NOTE` — their real gate is imperative
 * and the class decorator understates it.
 */
@ApiBearerAuth()
@ApiTags('admin-agents')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:agent:manage')
@Controller('admin/agents')
@CanManage('Agent')
export class AgentAdminController {
  constructor(@Inject(IAgentService) private readonly agentService: IAgentService) {}

  /**
   * TASK-890 OD-M/OD-K — `includeTemplates` is GONE, not deprecated. It used to append the SYSTEM
   * library to a tenant's list; an agent is CONTENT, so a tenant sees the copies it was
   * provisioned with (each carrying `sourceTenantId = SYSTEM` for the "from platform" badge) and
   * SYSTEM is never read on a tenant-facing path. An undeclared query key is ignored by Nest, so a
   * caller still sending `includeTemplates=true` gets exactly what it got while the parameter was
   * accepted-and-ignored.
   */
  @Get()
  @ApiOperation({ summary: 'List the caller tenant’s agent versions' })
  @ApiQuery({ name: 'task', required: false, enum: AgentTask })
  @ApiResponse({ status: 200, type: [AgentResponse] })
  async fetchAll(@Query('task') task?: AgentTask): Promise<AgentResponse[]> {
    return this.agentService.list(task);
  }

  /**
   * TASK-965 (OD-965-3) — the REGISTER: one row per SLUG, paginated by slug.
   *
   * DECLARED ABOVE every `:id` route on purpose: Nest matches in declaration order, so
   * `lineages` below `:id` would be read as an agent id and answer 404.
   */
  @Get('lineages')
  @ApiOperation({
    summary: 'List the caller tenant’s agent LINEAGES (one row per slug)',
    description:
      'The register shape: one row per slug carrying the ACTIVE published version, the newest open draft, the version counts and what the ' +
      'slug SERVES (tenant default / departments / tag selectors). `GET admin/agents` stays the per-VERSION read a Versions tab needs — ' +
      'grouping that one client-side is wrong at a page boundary, because `count` and the page slice here are LINEAGES, not rows. ' +
      '`task` narrows to one agent task; the inherited `filters`/`search` grammar narrows the VERSION rows, so a lineage is listed when ' +
      'any of its live versions match.',
  })
  @ApiResponse({ status: 200, type: PaginatedAgentLineageResponse })
  @ApiResponse({ status: 400, description: 'Unknown `task`, or a malformed `filters` token.' })
  async fetchLineages(@Query() query: ListAgentLineagesQuery): Promise<PaginatedAgentLineageResponse> {
    return this.agentService.listLineages(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one agent version (own or SYSTEM template)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent).' })
  async fetchById(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.getById(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Every version of this agent’s lineage, newest first' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: [AgentResponse] })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent).' })
  async fetchVersions(@Param('id') id: string): Promise<AgentResponse[]> {
    return this.agentService.listVersions(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new DRAFT agent version for the caller tenant' })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'Invalid configuration — `code` + `findings` name what failed (MODEL_TASK_MISMATCH, CONFIG, SCHEMA…).' })
  async create(@Body() request: CreateAgentRequest): Promise<AgentResponse> {
    return this.agentService.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a DRAFT/VALIDATED agent version (If-Match OCC)',
    description:
      'Sparse patch. `If-Match` (RFC 7232) is REQUIRED and CAS’es against the row `_version`; drift → 412, missing header → 428. ' +
      'Rejected 400 if the row is PUBLISHED/DEPRECATED (branch a new version instead). An edit returns a VALIDATED row to DRAFT.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateAgentRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<AgentResponse> {
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.agentService.update(id, effective, effective.expectedVersion);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an agent version (refused for the ACTIVE published version — deprecate it first)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  @ApiResponse({ status: 409, description: 'The row is the ACTIVE published version of its slug.' })
  async remove(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.deleteById(id);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run every publish-time check; stores the report and advances to VALIDATED when nothing blocks' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The row is PUBLISHED/DEPRECATED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async validate(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.validate(id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish an agent version (fails closed)',
    description:
      'Stamps `compiledConfig` (fully resolved references: model, fallback chain, pinned template, defaults) and, by default, elects this ' +
      'version ACTIVE for its slug. Refused 400 with `code` + `findings` when the model is unavailable (MODEL_UNAVAILABLE), the bound ' +
      'template is not APPROVED (TEMPLATE_NOT_APPROVED), the model’s task does not match (MODEL_TASK_MISMATCH) or a capability gate fails.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'Blocking findings — nothing was published; the report is stored on the row.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async publish(@Param('id') id: string, @Body() request: PublishAgentRequest): Promise<AgentResponse> {
    return this.agentService.publish(id, request ?? {});
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: 'Branch a new DRAFT version from ANY version (own lineage), or a new tenant lineage from a SYSTEM template',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant, or an unpublished SYSTEM draft).' })
  async newVersion(@Param('id') id: string, @Body() request: NewAgentVersionRequest): Promise<AgentResponse> {
    return this.agentService.newVersion(id, request ?? {});
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make an already-PUBLISHED version the ACTIVE one for its slug (rollback)',
    description:
      'Moves the `isActive` pointer and demotes the sibling that held it — the demoted version stays PUBLISHED and can be activated again. ' +
      'The published bytes are never touched, which is why this is allowed on an immutable row where an edit is not. Without it the only ' +
      'way back to an older version was to branch and republish it, which mints yet another version row. Every assignment naming this slug ' +
      'follows the pointer, so the departments that used vN now get this version.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The row is not PUBLISHED (a DRAFT must be published; a DEPRECATED version must be branched).' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async activate(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.activate(id);
  }

  @Post(':id/deprecate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The row is not PUBLISHED.' })
  @ApiResponse({ status: 404, description: 'Not found (or cross-tenant).' })
  async deprecate(@Param('id') id: string): Promise<AgentResponse> {
    return this.agentService.deprecate(id);
  }

  // =========================================================================
  // The draft-agent test bench (TASK-890 §3.8)
  // =========================================================================
  //
  // Two calls, for the same reason the prompt-template bench has two: the BROWSER is the real
  // consumer of the stream. `test` opens the generation and answers with a gateway-relative SSE
  // path the browser subscribes to with its own single-use ticket; `test/finalize` reads the
  // finished text back SERVER-SIDE by task id, because a client that could hand back the output
  // could decide what the platform records about the run.
  //
  // `@Throttle({ heavy })` is opt-in (the `default` tier gates everything anyway): a bench that
  // spends real tokens on the tenant's own quota is exactly the "AI processing" class that tier
  // was defined for.

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Assemble (and optionally run) a DRAFT agent without publishing it',
    description:
      'Compiles the DRAFT in memory through the SAME checks `publish` runs — nothing is persisted — renders its prompt over the runtime ' +
      'variable scope (`context.*` / `trigger.*`, `input.*`, and the bare names from `instruction.variables` overlaid by this request’s ' +
      '`variables`), and reports the resolved `{provider, model, fundingTier}`. `dryRun` DEFAULTS TO TRUE: a dry run generates nothing, ' +
      'costs nothing and meters nothing. With `dryRun: false` the run is charged to the tenant’s own `monthlyLlmTokens` quota (checked ' +
      'BEFORE anything is sent) and answers a `taskId` + gateway-relative `streamUrl`.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentTestAckResponse })
  @ApiResponse({
    status: 400,
    description:
      'Blocking findings (same `code` + `findings` shape as publish), an unresolved prompt variable (`PROMPT_VARIABLE_UNRESOLVED`, naming the path), ' +
      'a context payload that violates the agent’s bound schema (`CONTEXT_SCHEMA_VIOLATION`), a partial `{provider, model}` pair, or a non-TEXT_GENERATION agent asked for a live run.',
  })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent, and for a SYSTEM template).' })
  @ApiResponse({ status: 409, description: 'The row is PUBLISHED/DEPRECATED — a published agent is INVOKED, not tested.' })
  @ApiResponse({ status: 429, description: 'Rate limited, or the tenant’s `monthlyLlmTokens` allowance is exhausted.' })
  async test(@Param('id') id: string, @Body() request: TestAgentRequest): Promise<AgentTestAckResponse> {
    return this.agentService.testDraft(id, request ?? {});
  }

  @Post(':id/test/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read a finished draft-test generation back from TEXT and record its usage',
    description:
      'The output is read SERVER-SIDE by `taskId` and never accepted from the request body. Records `generate.stream` against the tenant ' +
      'with `trigger: AGENT_TEST`. Nothing is written to the agent row — a draft test is an authoring aid, not a version fact.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: AgentTestResultResponse })
  @ApiResponse({ status: 400, description: 'The generation has not reached a terminal completed state (the state is named).' })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent), or an unknown `taskId`.' })
  async finalizeTest(@Param('id') id: string, @Body() request: FinalizeAgentTestRequest): Promise<AgentTestResultResponse> {
    return this.agentService.finalizeDraftTest(id, request);
  }

  // =========================================================================
  // Portability (TASK-884) — clone, export, import, sync
  // =========================================================================
  //
  // These four address the agent by its lineage SLUG rather than a row id, because that is
  // what a person holds: a slug is stable across versions and is what an exported file, a
  // console link and another tenant all name. The id-addressed routes above are unchanged.

  @Post('import')
  @ApiOperation({
    summary: 'Import an exported agent bundle as a DRAFT in the caller tenant',
    description:
      'Validates the bundle ENVELOPE (kind / schemaVersion / source) and then its agent payload, and only then re-resolves every ' +
      'reference against what THIS tenant can see: the model by slug, the bound prompt template by name (a SYSTEM template keeps ' +
      'its id and its version pin; a tenant one is re-resolved and the pin dropped, because version lineages are per-tenant), and ' +
      'each MCP tool binding. Anything unresolvable is a 409 that names it — never a silently dropped binding. A bundle from a ' +
      'newer platform is refused outright rather than partially applied. The import always lands a DRAFT this tenant validates and ' +
      'publishes itself.',
  })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({
    status: 400,
    description:
      'Not a valid agent bundle (`BUNDLE_INVALID`), or its payload is malformed / carries a server-owned column (`BUNDLE_PAYLOAD_INVALID`).',
  })
  @ApiResponse({
    status: 409,
    description: 'A reference cannot be resolved here — `MODEL_NOT_RESOLVABLE`, `PROMPT_TEMPLATE_NOT_RESOLVABLE` or `MCP_SERVER_NOT_RESOLVABLE`.',
  })
  async importBundle(@Body() request: ImportAgentRequest): Promise<AgentResponse> {
    return this.agentService.importBundle(request);
  }

  @Get(':slug/export')
  @ApiOperation({
    summary: 'Export one agent version as a portable JSON bundle',
    description:
      'Values only. Models are named by registry SLUG, the bound prompt template by a re-resolvable reference, and every ' +
      'server-owned column (ids, tenant, status, compiledConfig) is absent. An agent carries no credential in the first place, so ' +
      'there is nothing to strip — which is why this file is safe to hand to a person. The eval gate is NOT exported (it points at ' +
      'a corpus of encrypted patient data) and `payload.notes` says so.',
  })
  @ApiParam({ name: 'slug', type: String, description: 'The agent lineage slug — the caller tenant’s own, or a SYSTEM template’s.' })
  @ApiQuery({ name: 'versionNumber', required: false, type: Number, description: 'Export this exact version instead of the ACTIVE PUBLISHED one.' })
  @ApiResponse({ status: 200, type: AgentBundleResponse })
  @ApiResponse({ status: 404, description: 'Not found (also returned for another tenant’s agent).' })
  @ApiResponse({ status: 409, description: 'The bound model row is no longer readable, so the agent cannot be exported by slug.' })
  async exportBySlug(@Param('slug') slug: string, @Query('versionNumber') versionNumber?: string): Promise<AgentBundleResponse> {
    return this.agentService.exportBySlug(slug, versionNumber ? Number(versionNumber) : undefined);
  }

  @Post(':slug/clone')
  @ApiOperation({
    summary: 'Clone a SYSTEM template or any visible agent into a NEW lineage',
    description:
      'Creates a DRAFT under `newSlug`, copying the source’s configuration and recording where it came from. Reusing the source ' +
      'slug in the same tenant is refused — that would be a new VERSION, which `POST {id}/versions` already is. A same-tenant clone ' +
      'keeps every binding, eval gate included; a clone into ANOTHER tenant (SUPER_ADMIN only) re-resolves the model by slug there ' +
      'and refuses a tenant-owned template or MCP binding rather than writing one the target cannot read.',
  })
  @ApiParam({ name: 'slug', type: String, description: 'The SOURCE agent’s lineage slug — the caller tenant’s own, or a SYSTEM template’s.' })
  @ApiResponse({ status: 201, type: AgentResponse })
  @ApiResponse({ status: 400, description: 'The new slug repeats the source’s in the same tenant, or the tags are not `key:value`.' })
  // AUTH-NOTE: the class-level `@CanManage('Agent')` UNDERSTATES the gate when the body names
  // a `tenantId`. A permission decorator expresses `action + subject`; it cannot express
  // "…and into THAT tenant". Cloning across a tenant boundary is enforced imperatively in
  // `AgentService.clone` as SUPER_ADMIN-only — a PRIVILEGE 403, not the 404-over-403
  // cross-tenant posture, because the caller named the tenant explicitly and is being told the
  // naming itself is above their level. A foreign SOURCE slug still answers 404. Never widen
  // this decorator without reading the service first.
  @ApiResponse({ status: 403, description: 'A `tenantId` was supplied by a caller who is not a platform administrator.' })
  @ApiResponse({ status: 404, description: 'Source not found (also returned for another tenant’s agent, and for an unpublished SYSTEM draft).' })
  @ApiResponse({
    status: 409,
    description:
      'A binding cannot be resolved in the target tenant — `MODEL_NOT_RESOLVABLE`, `PROMPT_TEMPLATE_NOT_PORTABLE` or `MCP_SERVER_NOT_PORTABLE`.',
  })
  async clone(@Param('slug') slug: string, @Body() request: CloneAgentRequest): Promise<AgentResponse> {
    return this.agentService.clone(slug, request);
  }

  @Post(':slug/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Push one of the caller’s own agents into other tenants the caller manages',
    description:
      'For an administrator who manages several tenants. Every target gets a DRAFT of the same version, in ONE transaction — either ' +
      'all of them received it or none did. The source must be the caller’s OWN agent (a SYSTEM template is already visible ' +
      'everywhere), and only SYSTEM-owned prompt-template and MCP bindings cross the boundary. This is NOT the Global → SYSTEM ' +
      'promotion path, which stays with `POST /admin/agent-promotions`.',
  })
  @ApiParam({ name: 'slug', type: String, description: 'The caller tenant’s own agent lineage slug.' })
  @ApiResponse({ status: 200, type: AgentSyncResponse })
  @ApiResponse({ status: 400, description: 'A target repeats the source tenant.' })
  // AUTH-NOTE: the class-level `@CanManage('Agent')` UNDERSTATES the gate. The real control —
  // the caller holds `manage:Agent` in EVERY named target — is enforced imperatively in
  // `AgentService.syncToTenants` via `PolicyEngine`, and it runs before any target is read or
  // written. A target the caller does not manage answers 404, NOT 403: the tenant id space is
  // not the caller's to probe, so "you may not" and "there is no such tenant" must be one
  // answer. (Contrast `AgentPromotionService`, which 403s — that caller is a super admin who is
  // already entitled to know both tenants exist.) Never widen this decorator without reading
  // the service first.
  @ApiResponse({
    status: 404,
    description: 'The source agent, or a target tenant the caller does not manage — the two are deliberately indistinguishable.',
  })
  @ApiResponse({
    status: 409,
    description: 'A binding is not portable across tenants — `PROMPT_TEMPLATE_NOT_PORTABLE`, `MCP_SERVER_NOT_PORTABLE` or `MODEL_NOT_RESOLVABLE`.',
  })
  async sync(@Param('slug') slug: string, @Body() request: SyncAgentRequest): Promise<AgentSyncResponse> {
    return this.agentService.syncToTenants(slug, request);
  }
}
