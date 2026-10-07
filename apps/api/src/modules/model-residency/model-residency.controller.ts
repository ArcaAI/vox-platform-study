import {
  CreateModelResidencyPolicyRequest,
  DismissModelResidencySuggestionResponse,
  IModelResidencyService,
  LinkModelResidencyRuntimeKeyRequest,
  LinkModelResidencyRuntimeKeyResponse,
  LoadModelResidencyRequest,
  ModelResidencyCatalogueResponse,
  ModelResidencyLoadPreviewResponse,
  ModelResidencyLoadResponse,
  ModelResidencyOperationResponse,
  ModelResidencyPinResponse,
  ModelResidencyPolicyResponse,
  ModelResidencyReadinessResponse,
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

const READ_SCOPES = ['svc:admin:model-residency:manage'] as const;
const MANAGE_SCOPE = 'svc:admin:model-residency:manage';

const FORBIDDEN = 'Not a platform administrator, or a working tenant is selected (this surface is platform-wide and tenant-less).';

/**
 * TASK-1005 — the platform-admin surface of the ModelResidencyController:
 * what is resident on the shared GPUs and host memory across stt, nlp and LM
 * Studio, the operator's load / unload / pin, the SYSTEM residency policies,
 * and the controller's (shadow-mode) recommendations. Routes and shapes are
 * pinned by `tests/contracts/model-residency-admin.fixture.json`, and the
 * catalogue-first `GET catalogue` by `tests/contracts/model-residency-catalogue.fixture.json`.
 *
 * Tenants never see this surface (D-11). `@ForbidApiKey()` keeps the business
 * plane out; a service account needs `svc:admin:model-residency:manage` for every route — one scope,
 * because every route already demands `manage:ModelResidencyPolicy` (a read-only scope could satisfy none).
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
  @Get('catalogue')
  @RequiredSvcScopes(...READ_SCOPES)
  @ApiOperation({
    summary: 'Read every loadable model per service, loaded or not, and who uses it',
    description:
      'Catalogue-first residency (TASK-1005 §13): every SELF_HOSTED, non-deleted catalogue model (SYSTEM tier), grouped by the workload that ' +
      'runs it — always four groups, in this order: stt, stt-worker, lm-studio, nlp (cloud models are absent: nothing can load them). Each ' +
      'model carries its status in plain words (`loaded` | `loading` | `unloading` | `not_loaded`), its size (MEASURED first, else the ' +
      'catalogue estimate, with `source` saying which), how long its last load took, where it is resident, who uses it across ALL tenants ' +
      '(`primary` agent model, `fallback`, or `routing` policy — only ACTIVE PUBLISHED agents and ACTIVE policies count; ' +
      '`liveConsultation` marks the live path), its keep policy in plain words with the reason, and the actions the console may offer now. ' +
      '`devices[]` names the models on each card; `suggestions[]` are the controller`s recommendations as one sentence each. The usage ' +
      'index is cached platform-wide for 30 s; everything else is as fresh as `GET admin/model-residency`. A resident model the catalogue ' +
      'does not know is still listed, with `aiModelId: null`.',
  })
  @ApiResponse({ status: 200, type: ModelResidencyCatalogueResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async catalogue(): Promise<ModelResidencyCatalogueResponse> {
    return this.service.getCatalogue();
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
  @Post('load/preview')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Preview a model load without doing it (dry-run admission)',
    description:
      'Runs EXACTLY the admission arithmetic of `POST load` and changes nothing — no command is sent, no operation, recommendation or audit ' +
      'record is created. Answers where the model would land, what admission reserves for it (`needBytes`: the measured footprint, else the ' +
      'catalogue size × 1.2; `null` = no size known), the device`s free memory, the `residency.headroomPercent` reserve, the memory no ' +
      'resident model accounts for, the shortfall, and what an un-forced load would answer (`refusal`: `ALREADY_LOADED`, `NO_SIZE`, ' +
      '`OVER_BUDGET`, or `null` = admitted). `evictable` lists the idle, unpinned on-demand models on the same device, largest first; `pinned` ' +
      'the resident models that will not be offered, with the reason. Same body as `POST load`.',
  })
  @ApiResponse({ status: 200, type: ModelResidencyLoadPreviewResponse })
  @ApiResponse({ status: 400, description: '`OPTIONS_UNSUPPORTED` or an invalid body' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async previewLoad(@Body() request: LoadModelResidencyRequest): Promise<ModelResidencyLoadPreviewResponse> {
    return this.service.previewLoad(request);
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
  @Post('links')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Confirm which catalogue model a runtime key is',
    description:
      'Records that the key a service REPORTS for a resident instance (exactly as reported, e.g. LM Studio`s `gemma-4-e2b-it-qat@q4_0`) is ' +
      'this SYSTEM catalogue model. Stored on the model (`_metadata.residency.runtimeKeys`, de-duplicated) and matched exactly from the next ' +
      'read on, so the instance stops showing as unknown and is never loaded a second time. Audited. Answers every key the model is now ' +
      'recognised under (its catalogue ref first).',
  })
  @ApiResponse({ status: 200, type: LinkModelResidencyRuntimeKeyResponse })
  @ApiResponse({ status: 400, description: 'An invalid body, or `SERVICE_MISMATCH` — the model is not run by that service' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: '`MODEL_UNKNOWN` — no such SYSTEM catalogue model (or it is deleted)' })
  async link(@Body() request: LinkModelResidencyRuntimeKeyRequest): Promise<LinkModelResidencyRuntimeKeyResponse> {
    return this.service.linkRuntimeKey(request);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Post('suggestions/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequiredSvcScopes(MANAGE_SCOPE)
  @ApiOperation({
    summary: 'Dismiss a standing residency recommendation',
    description:
      'Hides the recommendation until the controller reaches a DIFFERENT conclusion for that model (then it may show again). Recommendations ' +
      'and dismissals are kept in the gateway`s memory, per process (shadow mode); a restart clears both. Audited.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: DismissModelResidencySuggestionResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No such standing recommendation in this gateway process (it may have gone stale).' })
  async dismissSuggestion(@Param('id') id: string): Promise<DismissModelResidencySuggestionResponse> {
    return this.service.dismissSuggestion(id);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the note on `view`.
  @Get('readiness')
  @RequiredSvcScopes(...READ_SCOPES)
  @ApiOperation({
    summary: 'Read the enforce-readiness checklist',
    description:
      'Read-only: what must be true before `residency.enforce` is turned on — shadow review recorded (`residency.shadowReviewedAt`), every ' +
      'resident instance matched to a catalogue model, every GPU inside its headroom, decision state shared across gateway replicas, seven ' +
      'days of shadow observation, complete usage, budgeted never-measured models, audited actions — each with its evidence, plus the ' +
      'shadow decision counts since this gateway process started. The switch itself stays the `residency.enforce` setting.',
  })
  @ApiResponse({ status: 200, type: ModelResidencyReadinessResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async readiness(): Promise<ModelResidencyReadinessResponse> {
    return this.service.getReadiness();
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
