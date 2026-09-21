import {
  IInferenceEngineService,
  LmStudioRuntimeResponse,
  LoadLmStudioModelRequest,
  LoadLmStudioModelResponse,
  UnloadLmStudioModelResponse,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * TASK-996 Phase 3 — platform control over the shared LM Studio serving engine.
 *
 * A SEPARATE controller from `/admin/ai-models`, and deliberately so: the model
 * catalogue describes what EXISTS, while this describes what is RUNNING. The
 * two have different lifetimes (a row outlives every instance of it), different
 * failure modes (an unreachable engine is a result here, not a 500) and
 * different blast radius — a write here can take the text, guardrail and STT
 * workloads down together, because the two cards are time-sliced and time
 * slicing gives no memory isolation.
 *
 * `/ai-services/*` remains the READ-ONLY engine surface. This plane is the
 * deliberate, owner-approved exception (D-1) and is confined to its own path
 * so the read-only stance elsewhere is not quietly reversed.
 */
@ApiBearerAuth()
@ApiTags('admin-inference-engines')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-model:manage')
@Controller('admin/inference-engines/lm-studio')
@CanManage('AiModel')
export class InferenceEnginesController {
  constructor(
    @Inject(IInferenceEngineService)
    private readonly service: IInferenceEngineService,
  ) {}

  // AUTH-NOTE: the class-level `@CanManage('AiModel')` UNDERSTATES the real
  // gate on every route here. A permission decorator expresses `action +
  // subject`, and there is no "super admin" subject; tenant admins legitimately
  // hold abilities on `AiModel` for other operations. The actual control —
  // SUPER_ADMIN only — is enforced imperatively in
  // `LmStudioServingService.assertPlatformAdmin` (owner decision D-6). That
  // gate is ROW-INDEPENDENT: it answers identically for every model key,
  // existing or not, so it may run FIRST and does, which is the
  // `promote-to-system` ordering rather than the existence-then-privilege
  // ordering a split gate needs — there is no id space to protect. It is a 403
  // PRIVILEGE boundary, NOT the 404-over-403 cross-tenant posture: an unknown
  // model key is still a 404. Never widen or "fix" this decorator without
  // reading the service first.
  @Get('runtime')
  @ApiOperation({
    summary: 'Read what the LM Studio engine is currently serving, and on what VRAM',
    description:
      'Engine reachability, every visible GPU with its used/free/total framebuffer, every loaded instance with the configuration the engine ' +
      'ACTUALLY applied (read back from the instance, not from a stored profile), and the `lmStudio.serving.*` platform default a model with no ' +
      '`_metadata.serving` block inherits. Two honesty notes the response repeats: per-device VRAM comes from DCGM and is aggregated `max by (gpu)` ' +
      'because the exporter`s `pod` label is an arbitrary pick among the pods sharing a time-sliced card; and `kvCacheEstimateBytes` is DERIVED ' +
      'from `contextLength x parallel`, never measured — nothing in CUDA, NVML or DCGM reports per-model memory.',
  })
  @ApiResponse({ status: 200, type: LmStudioRuntimeResponse })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  async runtime(): Promise<LmStudioRuntimeResponse> {
    return this.service.runtime();
  }

  // AUTH-NOTE: super-admin only, imperatively — see the note on `runtime`.
  @Post('models/:modelKey/load')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Resolve a serving profile for one model and load it',
    description:
      'Resolves the profile request -> model row -> platform default (widening only on absence), refuses an incoherent combination with 400, and ' +
      'refuses an over-budget load with 409 unless `force: true`. ' +
      '⚠️ THE LOAD ITSELF CANNOT BE DISPATCHED ON THIS ENGINE BUILD and the route answers **501 `ENGINE_LOAD_UNSUPPORTED`** after the checks: ' +
      'LM Studio`s REST load endpoint fails for every payload on this deployment and carries no field for KV-cache quantization or GPU placement, ' +
      'and the one working loader speaks the SDK kvConfig websocket over loopback inside the pod at boot. The 501 body carries the same ' +
      '`applied` / `sources` / `estimateBytes` the 202 would, so a console can show the precheck before arming its button, and names the remedy ' +
      '(write the profile, restart the workload). Nothing is dispatched to the broken endpoint — doing so is what left the engine with no model ' +
      'loaded when it was measured.',
  })
  @ApiParam({ name: 'modelKey', description: 'The id the engine answers to on the wire — `AiModel.wireModelId`.', type: String })
  @ApiResponse({ status: 202, description: 'Accepted — the resolved profile and its VRAM estimate', type: LoadLmStudioModelResponse })
  @ApiResponse({ status: 400, description: '`{ problems: string[] }` — an incoherent resolved profile, or a request field the vocabulary rejects' })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  @ApiResponse({ status: 404, description: 'No platform catalogue row claims this model key.' })
  @ApiResponse({ status: 409, description: '`VRAM_BUDGET_EXCEEDED` (or `VRAM_BUDGET_UNREADABLE`) — bypass with `force: true`' })
  @ApiResponse({ status: 501, description: '`ENGINE_LOAD_UNSUPPORTED` — no gateway-reachable loader on this engine build' })
  async load(@Param('modelKey') modelKey: string, @Body() request: LoadLmStudioModelRequest): Promise<LoadLmStudioModelResponse> {
    return this.service.load(modelKey, request);
  }

  // AUTH-NOTE: super-admin only, imperatively — see the note on `runtime`.
  @Post('models/:identifier/unload')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Evict one loaded instance (ADVISORY — JIT reloads it)',
    description:
      'Unloads the named instance and returns its VRAM to the shared cards. `jitReloadPossible` is ALWAYS `true`, and it is a warning rather than ' +
      'a capability: JIT loading cannot be disabled on this build — there is no CLI flag, no REST field and no settings key for it — so the next ' +
      'inference request reloads the model, on the `lmStudio.jit.*` defaults rather than on the profile it was unloaded from. Use it to free ' +
      'memory now, never to keep a model gone.',
  })
  @ApiParam({ name: 'identifier', description: 'The loaded instance handle, as `GET runtime` reports it.', type: String })
  @ApiResponse({ status: 202, description: 'The engine accepted the unload', type: UnloadLmStudioModelResponse })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  @ApiResponse({ status: 404, description: 'No instance under that identifier is loaded.' })
  async unload(@Param('identifier') identifier: string): Promise<UnloadLmStudioModelResponse> {
    return this.service.unload(identifier);
  }
}
