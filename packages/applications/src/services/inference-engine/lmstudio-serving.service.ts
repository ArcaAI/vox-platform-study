import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AiModelRepository, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { type AiModelServingProfile, parseAiModelServingProfile } from '@arcaai/types';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common/base.service';
import { isSuperAdmin } from '../../common/tenant-guards';
import type { IActiveUserContext } from '../../interfaces';
import { declaredContextLengthOf, platformServingProfileFrom, resolveServingProfile, servingProfileOf } from '../ai-model/serving-profile.util';
import { IPrometheusQueryService } from '../platform-metrics/prometheus-query.service';
import { type LmStudioServingKey, LM_STUDIO_SERVING_DEFAULTS } from '../settings-registry/descriptors/lmstudio-serving.descriptors';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import type {
  LmStudioDeviceResponse,
  LmStudioRuntimeResponse,
  LmStudioServingProfileSource,
  LoadLmStudioModelRequest,
  LoadLmStudioModelResponse,
  UnloadLmStudioModelResponse,
} from './dto';
import type { IInferenceEngineService } from './IInferenceEngineService';
import { LmStudioEngineClient, type LmStudioSnapshot } from './lmstudio-engine.client';
import { LM_STUDIO_MODEL_KEY, kvCacheEstimateBytes, loadEstimateBytes } from './vram-estimate';

/**
 * TASK-996 Phase 3 — the gateway's LM Studio serving-control plane.
 *
 * ── THE GATE CHAIN, AND WHY IT IS IN THIS ORDER ──────────────────────────────
 *
 *   1. SUPER_ADMIN (403). ROW-INDEPENDENT: it answers identically for every
 *      model key, existing or not, so it may run FIRST and does — the
 *      `promote-to-system` ordering in `05-nestjs-api.md`, not the
 *      existence-then-privilege ordering a SPLIT gate needs. There is no id
 *      space to protect because a non-platform-admin gets the same 403 for
 *      every input. This is a PRIVILEGE boundary, not the 404-over-403
 *      cross-tenant posture: an unknown model key is still a 404.
 *   2. Existence (404) — a `wireModelId` no SYSTEM catalogue row claims.
 *   3. Profile coherence (400) — from the SHARED resolver's `problems`, never
 *      re-derived here.
 *   4. Live VRAM budget (409, owner decision D-6) — and this is the ONLY gate
 *      `force: true` bypasses.
 *
 * ── WHY `load` CANNOT DISPATCH ───────────────────────────────────────────────
 *
 * It refuses with 501 `ENGINE_LOAD_UNSUPPORTED` after running the whole chain.
 * That is not a stub: it is the measured state of this engine build.
 * `POST /api/v1/models/load` fails on this deployment under every payload,
 * including a control carrying only `{model, context_length}` (ticket §2.8),
 * and even where it answered it has no field for KV-cache quantization or GPU
 * placement. The one working loader speaks the `@lmstudio/sdk` kvConfig
 * websocket over LOOPBACK inside the pod, at boot. Calling the broken endpoint
 * to look complete would evict the served model and leave the AI plane with
 * nothing loaded — which is exactly what the §2.8 measurement did.
 *
 * The 501 body still carries `applied`, `sources` and `estimateBytes`, so the
 * console's "show the precheck before arming the button" step has a real answer
 * today and the shape does not change when a reachable loader lands.
 */
@Injectable()
export class LmStudioServingService extends BaseService implements IInferenceEngineService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    private readonly engine: LmStudioEngineClient,
    // Symbol token, so the parameter type alone cannot resolve it.
    @Inject(IPrometheusQueryService) private readonly prometheus: IPrometheusQueryService,
    private readonly effectiveSettings: EffectiveSettingsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  async runtime(): Promise<LmStudioRuntimeResponse> {
    this.assertPlatformAdmin('read the serving runtime');

    const [snapshot, devices, platformDefault] = await Promise.all([this.engine.snapshot(), this.devices(), this.platformDefault()]);

    const loaded = snapshot.models.flatMap((model) =>
      model.instances.map((instance) => {
        // The ENGINE's own read-back, not a stored profile: a runtime screen
        // that showed what was requested rather than what is running would hide
        // exactly the drift this ticket was opened to catch (§2.7).
        const effective: AiModelServingProfile = {};
        if (instance.contextLength !== undefined) effective.contextLength = instance.contextLength;
        if (instance.parallel !== undefined) effective.parallel = instance.parallel;
        if (instance.flashAttention !== undefined) effective.flashAttention = instance.flashAttention;

        return {
          identifier: instance.identifier,
          modelKey: model.modelKey,
          weightsBytes: model.weightsBytes,
          // This build reports no busy/idle distinction over HTTP; see the DTO.
          status: 'IDLE' as const,
          effective,
          kvCacheEstimateBytes: kvCacheEstimateBytes(effective),
        };
      }),
    );

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { engine: 'lm-studio', loaded: loaded.length } });
    return { engine: { reachable: snapshot.reachable }, devices, loaded, platformDefault };
  }

  async load(modelKey: string, request: LoadLmStudioModelRequest): Promise<LoadLmStudioModelResponse> {
    this.assertPlatformAdmin('load a model');

    const entity = await this.requireCatalogueRow(modelKey);
    const { profile, sources } = this.resolveProfile(entity, await this.platformDefault(), request.profile);

    const snapshot = await this.engine.snapshot();
    const weightsBytes = snapshot.models.find((model) => model.modelKey === modelKey)?.weightsBytes ?? 0;
    const estimateBytes = loadEstimateBytes(weightsBytes, profile);

    if (request.force !== true) await this.assertFitsOneCard(estimateBytes);

    // The honest refusal. See the class doc — nothing is dispatched, and in
    // particular the engine's own broken REST load is never called.
    throw new NotImplementedException({
      code: 'ENGINE_LOAD_UNSUPPORTED',
      message:
        'This LM Studio build exposes no loader the gateway can drive: its REST load endpoint fails for every payload on this deployment and ' +
        'carries no field for KV-cache quantization or GPU placement, and the working kvConfig websocket loader runs inside the pod at boot. ' +
        'The resolved profile and its VRAM estimate are reported below so the change can be applied through the pod`s own loader.',
      remedy:
        'Set the profile on the model row (`AiModel._metadata.serving`) or on the platform tier (`lmStudio.serving.*`), then restart the ' +
        '`hope-lmstudio` workload so its A-6 preloader applies it.',
      modelKey,
      applied: profile,
      sources,
      estimateBytes,
    });
  }

  async unload(identifier: string): Promise<UnloadLmStudioModelResponse> {
    this.assertPlatformAdmin('unload a model');

    const snapshot = await this.engine.snapshot();
    const known = snapshot.models.some((model) => model.instances.some((instance) => instance.identifier === identifier));
    if (!known) throw new NotFoundException(`No LM Studio instance named '${identifier}' is loaded.`);

    await this.engine.unload(identifier);
    // A platform-disruptive action on shared, time-sliced cards has to stay
    // attributable to the administrator who took it.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, { data: { engine: 'lm-studio', action: 'unload', identifier } });

    return { unloaded: true, jitReloadPossible: true };
  }

  // ── gates ─────────────────────────────────────────────────────────────────

  /**
   * AUTH-NOTE: the route's `@CanManage('AiModel')` UNDERSTATES this gate. A
   * permission decorator expresses `action + subject` and there is no
   * "super admin" subject, while tenant admins legitimately hold abilities on
   * `AiModel` for other operations. Loading and unloading decide how much VRAM
   * one process takes on cards shared with `hope-stt` and the guardrail model,
   * under GPU time-slicing that gives NO memory isolation — so it is platform
   * administration (owner decision D-6). Row-independent, hence first.
   */
  private assertPlatformAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Only platform administrators may ${action} on the shared serving engine.`);
    }
  }

  /** The SYSTEM catalogue row that claims this engine wire id, or 404. */
  private async requireCatalogueRow(modelKey: string) {
    const rows = await this.aiModelRepository.findAll({
      filters: { tenantId: SYSTEM_TENANT_ID, [LM_STUDIO_MODEL_KEY]: modelKey },
      limit: 1,
    });
    const entity = rows[0];
    if (!entity) throw new NotFoundException(`Model '${modelKey}' is not in the platform catalogue.`);
    return entity;
  }

  /**
   * Request -> model row -> platform default, widening ONLY on absence.
   *
   * Built from TWO passes of the SHARED `resolveServingProfile` rather than a
   * third merge written here: the model/platform pass is the same one the
   * admin projection and the pod's loader read through, and the request pass
   * layers over its result. Re-implementing the precedence locally is how the
   * console, the API and the loader end up disagreeing about what is in force.
   *
   * A request field the profile vocabulary REJECTS becomes a problem rather
   * than a silent drop — see `LoadLmStudioModelRequest`.
   */
  private resolveProfile(
    entity: Parameters<typeof servingProfileOf>[0],
    platformDefault: AiModelServingProfile,
    requested: Record<string, unknown> | undefined,
  ): { profile: AiModelServingProfile; sources: Record<string, LmStudioServingProfileSource> } {
    const declaredContextLength = declaredContextLengthOf(entity);
    const base = resolveServingProfile(servingProfileOf(entity), platformDefault, { declaredContextLength });

    const parsed = requested === undefined ? { profile: {}, rejected: [] as string[] } : parseAiModelServingProfile(requested);
    if (parsed.rejected.length > 0) {
      throw new BadRequestException({
        problems: parsed.rejected.map(
          (path) =>
            `'${path}' is not a serving-profile field this engine accepts, or its value is out of range. ` +
            'Nothing was loaded — an override that is only half applied serves the model on parameters nobody chose.',
        ),
      });
    }

    const merged = resolveServingProfile(parsed.profile, base.profile, { declaredContextLength });
    if (merged.problems.length > 0) throw new BadRequestException({ problems: merged.problems });

    // `merged.sources` labels the FIRST argument `model`; here that argument is
    // the REQUEST, and its `platform` means "came from the model/platform pass".
    const sources: Record<string, LmStudioServingProfileSource> = {};
    for (const [field, tier] of Object.entries(merged.sources)) {
      sources[field] = tier === 'model' ? 'request' : (base.sources[field] ?? 'platform');
    }
    return { profile: merged.profile, sources };
  }

  /**
   * The D-6 budget refusal, against the BEST SINGLE CARD.
   *
   * Not the sum of both: a model that does not fit one device is split across
   * them, every decoded token then pays a PCIe hop, and that split is the
   * pathology this ticket exists to remove rather than to budget for. The
   * number matches the GPU dashboard's "best single-card headroom" panel, which
   * is written down there as the one the Phase-3 precheck must compare against.
   *
   * Fails CLOSED when DCGM has nothing to say: the cards give no memory
   * isolation under time-slicing, so an unverifiable budget is not a safe one.
   * `force: true` is how an operator overrides that, and it is checked by the
   * caller so the bypass is visible at the call site.
   */
  private async assertFitsOneCard(estimateBytes: number): Promise<void> {
    const devices = await this.devices();
    if (devices.length === 0) {
      throw new ConflictException({
        code: 'VRAM_BUDGET_UNREADABLE',
        message:
          'Free VRAM could not be read from DCGM, so the load budget cannot be checked. The cards are time-sliced and give no memory isolation, ' +
          'so an unverifiable budget is refused rather than assumed. Re-send with `force: true` to proceed anyway.',
        estimateBytes,
      });
    }

    const freeBytes = Math.max(...devices.map((device) => device.freeMib)) * 1024 * 1024;
    if (estimateBytes > freeBytes) {
      throw new ConflictException({
        code: 'VRAM_BUDGET_EXCEEDED',
        message:
          `The estimated residency (${estimateBytes} bytes) exceeds the free memory of the largest single card (${freeBytes} bytes). ` +
          'Lower contextLength or parallel, quantize the KV cache, or re-send with `force: true` to accept the risk of splitting the model ' +
          'across both cards — or of a CUDA OOM that takes its card-mates down with it.',
        estimateBytes,
        freeBytes,
      });
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /**
   * Per-device VRAM from DCGM.
   *
   * Aggregated `max by (gpu)` and NEVER grouped by `pod`. `DCGM_FI_DEV_*` is
   * per DEVICE; dcgm-exporter decorates it with a `pod` label taken from the
   * kubelet's device->pod map, and under time-slicing that label is an
   * arbitrary pick among the pods sharing the card. Measured 2026-09-21: GPU 1
   * read 8,917 MiB labelled `hope-stt-worker` while `nvidia-smi` inside
   * `hope-lmstudio` showed its own `llama-server` holding 8,908 of them.
   *
   * There is no `DCGM_FI_DEV_FB_TOTAL` on this exporter, so the physical
   * ceiling is reconstructed as used + free + reserved (which reproduces the
   * cards' 16,380 MiB).
   */
  private async devices(): Promise<LmStudioDeviceResponse[]> {
    const [used, free, reserved] = await Promise.all([
      this.prometheus.instantVector('max by (gpu, modelName) (DCGM_FI_DEV_FB_USED)'),
      this.prometheus.instantVector('max by (gpu) (DCGM_FI_DEV_FB_FREE)'),
      this.prometheus.instantVector('max by (gpu) (DCGM_FI_DEV_FB_RESERVED)'),
    ]);

    const byGpu = (samples: typeof free): Map<string, number> => new Map(samples.map((sample) => [sample.metric.gpu, sample.value]));
    const freeByGpu = byGpu(free);
    const reservedByGpu = byGpu(reserved);

    return used
      .map((sample) => {
        const gpu = sample.metric.gpu;
        const usedMib = Math.round(sample.value);
        const freeMib = Math.round(freeByGpu.get(gpu) ?? 0);
        return {
          index: Number(gpu),
          name: sample.metric.modelName ?? 'unknown',
          totalMib: usedMib + freeMib + Math.round(reservedByGpu.get(gpu) ?? 0),
          usedMib,
          freeMib,
        };
      })
      .filter((device) => Number.isInteger(device.index))
      .sort((a, b) => a.index - b.index);
  }

  /**
   * The `lmStudio.serving.*` platform tier, through the registry's own cascade.
   *
   * SYSTEM is passed EXPLICITLY. These keys are `globalOnly` / `maxScope:
   * 'system'`, so there is no tenant tier to widen from; reading them for the
   * caller's working tenant would invent one.
   */
  private async platformDefault(): Promise<AiModelServingProfile> {
    const keys = Object.keys(LM_STUDIO_SERVING_DEFAULTS).filter((key) => key.startsWith('lmStudio.serving.')) as LmStudioServingKey[];
    const values: Partial<Record<LmStudioServingKey, unknown>> = {};
    for (const key of keys) {
      // `open-to-default` throughout this family: a key that cannot be resolved
      // leaves the field absent, which is the same as no tier having an opinion.
      const resolved = await this.effectiveSettings.resolveEffective(key, { tenantId: SYSTEM_TENANT_ID }).catch(() => null);
      if (resolved) values[key] = resolved.value;
    }
    return platformServingProfileFrom(values);
  }
}

/** Re-exported so a caller can type the engine read without importing the client module. */
export type { LmStudioSnapshot };
