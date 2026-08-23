import {
  CreateWorkflowInvariantRuleRequest,
  IWorkflowInvariantRuleService,
  PaginatedQuery,
  PaginatedWorkflowInvariantRuleResponse,
  UpdateWorkflowInvariantRuleRequest,
  WorkflowInvariantRuleResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiresIfMatch } from '../../decorators';

/**
 * WorkflowInvariantRuleController — tenant-scoped CRUD for the validator's rule rows
 * (TASK-790 W3b), mounted at `/admin/workflow-invariant-rules`.
 *
 * Closes TASK-789 finding H-1: the model had NO HTTP surface at all, so a tenant admin could
 * not write a row and the capability `workflow-invariant-rule.prisma`'s header documents ("a
 * tenant may add strictness rules") did not exist in the running system. `WorkflowValidatorService`
 * — which resolves these rows and merges them one-way-strict — is wired into the definition
 * lifecycle by W3(a); this controller is what lets the rows it resolves come from anywhere but a
 * seed.
 *
 * Mirrors `WorkflowDefinitionController`: mapper-in-service, If-Match OCC fold on PATCH,
 * class-level `@CanManage`, `@ForbidApiKey` (this is an admin governance surface, not a business
 * -plane one).
 */
@ApiBearerAuth()
@ApiTags('admin-workflow-invariant-rules')
@ForbidApiKey()
// NO `@RequiredSvcScopes` — deliberately, and it is the SAFE posture, not an oversight. Adding a
// scope requires declaring it in `SERVICE_ACCOUNT_SCOPE_REGISTRY`
// (`packages/applications/src/services/serviceAccount/`) and regenerating `vox-node`'s generated
// admin area, neither of which this ticket owns (TASK-790 ownership boundary). With no scope
// declared, BOTH machine credential classes are denied by default (rule 05 §API Test Standard:
// "No scope declaration = deny-by-default 403 for BOTH machine classes") — so this surface is
// reachable only by a tenant-admin / super-admin JWT, which is the audience a governance surface
// wants. Whoever owns the service-account registry can widen it later; see the ticket's
// `requestedContracts`.
@Controller('admin/workflow-invariant-rules')
@CanManage('WorkflowInvariantRule')
export class WorkflowInvariantRuleController {
  constructor(
    @Inject(IWorkflowInvariantRuleService)
    private readonly workflowInvariantRuleService: IWorkflowInvariantRuleService,
  ) {}

  @Post()
  // AUTH-NOTE: the class-level `manage:WorkflowInvariantRule` ability UNDERSTATES the real gate
  // on the write routes of this controller. `WorkflowInvariantRule` is a SYSTEM-shared READ model:
  // every tenant reads the SYSTEM platform register, but only a SUPER_ADMIN may MUTATE a
  // SYSTEM-owned row — a tenant admin holding `manage` may write only its own tenant's rows
  // (`workflow-invariant-rule.prisma` header: "a tenant row may only ADD strictness ... it can
  // never disable, loosen, or delete a SYSTEM-owned row"). There is no "super admin" SUBJECT to
  // express that declaratively, so it is enforced imperatively in
  // `WorkflowInvariantRuleService.assertWritable` — read it before widening anything here. That
  // 403 is a PRIVILEGE boundary, not the 404-over-403 cross-tenant posture: another tenant's row
  // still returns 404. Same shape as `SUPER_ADMIN_ONLY_POLICY_KEYS` (rule 05).
  @ApiOperation({
    summary: 'Author a workflow invariant rule for the caller tenant',
    description:
      "One parameterization of a code-owned predicate KIND. The row is always owned by the CALLER's tenant — " +
      '`tenantId` is not accepted in the body. A rule sharing a `ruleId` with a SYSTEM rule may only RAISE its ' +
      'severity at evaluation time; it can never redefine what the platform rule checks.',
  })
  @ApiResponse({ status: 201, type: WorkflowInvariantRuleResponse })
  @ApiResponse({ status: 400, description: 'Bad request — malformed ruleId, or a paletteKey the node registry does not declare.' })
  async create(@Body() request: CreateWorkflowInvariantRuleRequest): Promise<WorkflowInvariantRuleResponse> {
    return this.workflowInvariantRuleService.create(request);
  }

  @Get()
  @ApiOperation({
    summary: "List the caller tenant's own rules UNION the SYSTEM platform register",
    description: 'SYSTEM rows carry `isSystemOwned: true` and are read-only for a tenant admin — render them as the register being added to.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWorkflowInvariantRuleResponse })
  @ApiResponse({ status: 400, description: 'Bad request — malformed pagination parameters.' })
  async fetchAll(@Query() query: PaginatedQuery): Promise<PaginatedWorkflowInvariantRuleResponse> {
    return this.workflowInvariantRuleService.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one rule — the caller tenant’s own, or a SYSTEM register row',
    description:
      'A SYSTEM row is readable by every tenant (it is the platform register they inherit) but carries `isSystemOwned: true` and is not editable here. Another tenant’s row returns 404, not 403 — the 404-over-403 posture hides existence across the tenant boundary.',
  })
  @ApiParam({ name: 'id', description: 'WorkflowInvariantRule id' })
  @ApiResponse({ status: 200, type: WorkflowInvariantRuleResponse })
  @ApiResponse({ status: 404, description: "Not found, or another tenant's row (existence hidden)." })
  async fetchById(@Param('id') id: string): Promise<WorkflowInvariantRuleResponse> {
    return this.workflowInvariantRuleService.getById(id);
  }

  @Patch(':id')
  @RequiresIfMatch()
  // AUTH-NOTE: see the marker on `create` above — a SYSTEM-owned row is SUPER_ADMIN-only here.
  @ApiOperation({
    summary: 'Update a rule (If-Match OCC)',
    description:
      'Sparse patch. `If-Match` is REQUIRED and CASes against the row `_version`; drift → 412, missing → 428. ' +
      '`ruleId`, `predicateType` and `paletteKey` are not patchable — changing any of them makes the row a ' +
      'DIFFERENT rule, which is an insert. Bump `ruleVersion` whenever `predicateConfig` changes, or published ' +
      'definitions silently keep an old verdict.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'WorkflowInvariantRule id' })
  @ApiResponse({ status: 200, type: WorkflowInvariantRuleResponse })
  @ApiResponse({ status: 403, description: 'The row is SYSTEM-owned (the platform register) and the caller is not a super admin.' })
  @ApiResponse({ status: 404, description: "Not found, or another tenant's row." })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateWorkflowInvariantRuleRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WorkflowInvariantRuleResponse> {
    const effectiveRequest: UpdateWorkflowInvariantRuleRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.workflowInvariantRuleService.update(id, effectiveRequest);
  }

  @Delete(':id')
  // AUTH-NOTE: see the marker on `create` above — a SYSTEM-owned row is SUPER_ADMIN-only here.
  @ApiOperation({
    summary: 'Soft-delete a rule',
    description:
      'Sets `resourceStatus: DELETED` rather than removing the row, so a rule that once governed a published definition stays auditable. A SYSTEM-owned register row is SUPER_ADMIN-only (403 — a privilege boundary, deliberately not the 404-over-403 cross-tenant posture).',
  })
  @ApiParam({ name: 'id', description: 'WorkflowInvariantRule id' })
  @ApiResponse({ status: 200, type: WorkflowInvariantRuleResponse })
  @ApiResponse({ status: 403, description: 'The row is SYSTEM-owned (the platform register) and the caller is not a super admin.' })
  @ApiResponse({ status: 404, description: "Not found, or another tenant's row." })
  async delete(@Param('id') id: string): Promise<WorkflowInvariantRuleResponse> {
    return this.workflowInvariantRuleService.deleteById(id);
  }
}
