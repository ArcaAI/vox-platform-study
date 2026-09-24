import {
  CreateModelResidencyPolicyRequest,
  IModelResidencyService,
  LoadModelResidencyRequest,
  ModelResidencyLoadResponse,
  ModelResidencyOperationResponse,
  ModelResidencyPinResponse,
  ModelResidencyPolicyResponse,
  ModelResidencyUnloadResponse,
  ModelResidencyViewResponse,
  PinModelResidencyRequest,
  UnloadModelResidencyRequest,
  UpdateModelResidencyPolicyRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CanManage, ExpectedVersion, ForbidApiKey, RequiredSvcScopes, RequiresIfMatch } from '../../decorators';

const READ_SCOPES = ['svc:admin:model-residency:read', 'svc:admin:model-residency:manage'] as const;
const MANAGE_SCOPE = 'svc:admin:model-residency:manage';

const FORBIDDEN = 'Not a platform administrator, or a working tenant is selected (this surface is platform-wide and tenant-less).';

/**
 * TASK-1005 — the platform-admin surface of the ModelResidencyController:
 * what is resident on the shared GPUs and host memory across stt, nlp and LM
 * Studio, the operator's load / unload / pin, the SYSTEM residency policies,
 * and the controller's (shadow-mode) recommendations. Routes and shapes are
 * pinned by `tests/contracts/model-residency-admin.fixture.json`.
 *
 * Tenants never see this surface (D-11). `@ForbidApiKey()` keeps the business
 * plane out; a service account needs `svc:admin:model-residency:read` (reads)
 * or `:manage` (writes).
 */
@ApiBearerAuth()
@ApiTags('admin-model-residency')
@ForbidApiKey()
@Controller('admin/model-residency')
@CanManage('ModelResidencyPolicy')
export class ModelResidencyController {
  constructor(
    @Inject(IModelResidencyService)
    private readonly service: IModelResidencyService,
  ) {}

  // AUTH-NOTE: the class-level `@CanManage('ModelResidencyPolicy')` UNDERSTATES
  // the real gate on every route here. There is no "super admin" CASL subject;
  // the actual control — SUPER_ADMIN in a tenant-LESS context (a selected
  // working tenant is itself a 403) — is enforced imperatively in
  // `ModelResidencyService.assertPlatformAdmin`, because residency decides how
  // much memory each process holds on cards every tenant's workload shares
  // (D-11). That gate is ROW-INDEPENDENT (the same answer for every model and
  // policy id), so it runs FIRST — the promote-to-system ordering, not the
  // existence-then-privilege ordering of a split gate. It is a 403 privilege
  // boundary; an unknown policy or operation id is still a 404 after it.
  // Never widen or "fix" this decorator without reading the service first.
  @Get()
  @RequiredSvcScopes(...READ_SCOPES)
  @ApiOperation({
    summary: 'Read live model residency across stt, nlp and LM Studio',
    description:
      'Every GPU (DCGM used / free / total, utilisation) and host-memory pool, every resident model with its MEASURED footprint (never a catalogue ' +
      'estimate), in-flight count, requests/min and p50 latency from Prometheus, its residency class (explicit policy, implicit live-path pin, or ' +
      'default) — and the controller`s recent recommendations. `mode` is `shadow` until the SYSTEM setting `residency.enforce` is true: in shadow ' +
      'the controller only RECORDS what it would do. `freshness.staleServices` lists services whose last report is older than 30 s; their rows ' +
      'are the last known state. stt-worker is observed through Prometheus only (it has no control API).',
  })
  @ApiResponse({ status: 200, type: ModelResidencyViewResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async view(): Promise<ModelResidencyViewResponse> {
    return this.service.getView();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Post('load')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Load a model on stt, nlp or LM Studio (asynchronous)',
    description:
      'ASYNCHRONOUS: answers 202 with an operation id as soon as the load is admitted, because a 5 GB LLM takes ~100 s — past the edge ' +
      'timeout of a browser request. Poll `GET operations/:operationId`, or watch the model`s `state` go `loading` → `loaded` in `GET`. A model ' +
      'already resident answers 200 `already_loaded` and creates no operation. Loads are serialised per PHYSICAL GPU across every service (an ' +
      'LM Studio load holds both cards) so every footprint is measurable: a second load on a busy card is 409 `LOAD_IN_PROGRESS`. A load that ' +
      'does not fit the measured free memory minus `residency.headroomPercent` is 409 `OVER_BUDGET` unless `force: true` AND a non-empty ' +
      '`reason` (owner OD-3; audited) — the cards are time-sliced and give no memory isolation. `options` (LM Studio REST v1 documented keys ' +
      'only) are accepted for `lm-studio` alone (400 `OPTIONS_UNSUPPORTED`); `replace: true` unloads then reloads as ONE operation.',
  })
  @ApiResponse({ status: 202, description: '`outcome: accepted` — the load runs in the background', type: ModelResidencyLoadResponse })
  @ApiResponse({ status: 200, description: '`outcome: already_loaded`', type: ModelResidencyLoadResponse })
  @ApiResponse({ status: 400, description: '`OPTIONS_UNSUPPORTED`, an invalid body, or `LOAD_FAILED` (no load spec could be derived)' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: '`MODEL_UNKNOWN` — nothing can load this model on that service' })
  @ApiResponse({ status: 409, description: '`OVER_BUDGET`, `LOAD_IN_PROGRESS`, or `IN_FLIGHT` (replace of a model serving requests)' })
  async load(@Body() request: LoadModelResidencyRequest, @Res({ passthrough: true }) response: Response): Promise<ModelResidencyLoadResponse> {
    const result = await this.service.load(request);
    if (result.status !== HttpStatus.ACCEPTED) response.status(result.status);
    return result.body;
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Post('unload')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Unload a model from stt, nlp or LM Studio',
    description:
      'Synchronous. Refused 409 `IN_FLIGHT` while the model serves requests unless `force: true`. Starts the reload cool-down ' +
      '(`residency.reloadCooldownSeconds`), so the controller will not immediately load it back; a live request still may. Audited with `reason`.',
  })
  @ApiResponse({ status: 200, type: ModelResidencyUnloadResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: '`MODEL_UNKNOWN`' })
  @ApiResponse({ status: 409, description: '`IN_FLIGHT` (with `inFlight`) or `LOAD_IN_PROGRESS`' })
  @ApiResponse({ status: 503, description: '`SERVICE_UNREACHABLE` — the serving process did not answer' })
  async unload(@Body() request: UnloadModelResidencyRequest): Promise<ModelResidencyUnloadResponse> {
    return this.service.unload(request);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Put('pins')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Pin or unpin a resident model (and set its idle TTL)',
    description:
      'A pinned model survives its idle TTL and is never evicted by LRU or memory pressure. stt and nlp pin in the serving process itself; ' +
      'LM Studio has no pin, so the controller holds it (and enforces the TTL by unloading on idle).',
  })
  @ApiResponse({ status: 200, type: ModelResidencyPinResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: '`MODEL_UNKNOWN` — the model is not resident on that service' })
  async pin(@Body() request: PinModelResidencyRequest): Promise<ModelResidencyPinResponse> {
    return this.service.pin(request);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Get('operations/:operationId')
  @RequiredSvcScopes(...READ_SCOPES)
  @ApiOperation({
    summary: 'Read the progress of an asynchronous load',
    description: '`running`, `succeeded` or `failed` (with `{code, message}`). Operations are kept in the gateway`s memory, bounded, per process.',
  })
  @ApiParam({ name: 'operationId', type: String })
  @ApiResponse({ status: 200, type: ModelResidencyOperationResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No such operation in this gateway process.' })
  async operation(@Param('operationId') operationId: string): Promise<ModelResidencyOperationResponse> {
    return this.service.getOperation(operationId);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Get('policies')
  @RequiredSvcScopes(...READ_SCOPES)
  @ApiOperation({
    summary: 'List the SYSTEM residency policies',
    description:
      'One row per (model, service): its class (`PINNED` | `WARM` | `ON_DEMAND`), idle TTL, priority, instance ceiling and placement hint.',
  })
  @ApiResponse({ status: 200, type: [ModelResidencyPolicyResponse] })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async listPolicies(): Promise<ModelResidencyPolicyResponse[]> {
    return this.service.listPolicies();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Post('policies')
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Create a SYSTEM residency policy',
    description: 'Residency is platform configuration: every row is a SYSTEM row. A second policy for the same (model, service) pair is 409.',
  })
  @ApiResponse({ status: 201, type: ModelResidencyPolicyResponse })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No such model' })
  @ApiResponse({ status: 409, description: '`POLICY_EXISTS`' })
  async createPolicy(@Body() request: CreateModelResidencyPolicyRequest): Promise<ModelResidencyPolicyResponse> {
    return this.service.createPolicy(request);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Patch('policies/:id')
  @RequiresIfMatch()
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Update a SYSTEM residency policy',
    description:
      'Optimistic concurrency: the `If-Match` header (RFC 7232) is REQUIRED and wins over the body `expectedVersion`; the server compares it ' +
      'with the row`s `_version`. Drift is 412, a missing header 428.',
  })
  @ApiHeader({ name: 'If-Match', description: 'The `_version` the client read, e.g. `"1"`.', required: true, example: '"1"' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ModelResidencyPolicyResponse })
  @ApiResponse({ status: 400, description: 'Invalid body, or no change to write' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No such policy' })
  @ApiResponse({ status: 412, description: 'The policy changed since it was read — re-read and retry.' })
  @ApiResponse({ status: 428, description: 'If-Match is required.' })
  async updatePolicy(
    @Param('id') id: string,
    @Body() request: UpdateModelResidencyPolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ModelResidencyPolicyResponse> {
    const effective = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.service.updatePolicy(id, effective);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Delete('policies/:id')
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Delete a SYSTEM residency policy (soft delete)',
    description: 'The model returns to its default class — implicit PINNED when it backs the live path, `ON_DEMAND` otherwise.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: ModelResidencyPolicyResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No such policy' })
  async deletePolicy(@Param('id') id: string): Promise<ModelResidencyPolicyResponse> {
    return this.service.deletePolicy(id);
  }
}
