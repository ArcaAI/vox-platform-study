import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AiModelRepository, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import type { AiModelServingProfile } from '@arcaai/types';
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
  LoadLmStudioModelRequest,
  LoadLmStudioModelResponse,
  UnloadLmStudioModelResponse,
} from './dto';
import type { IInferenceEngineService } from './IInferenceEngineService';
import { LmStudioEngineClient, LmStudioEngineError, type LmStudioLoadOptions, type LmStudioSnapshot } from './lmstudio-engine.client';
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
 *      `force: true` bypasses. Skipped when the key is already resident: its
 *      weights are already on the cards, and the adapter answers
 *      `already_loaded` without loading anything.
 *
 * ── THE DISPATCH (TASK-1005) ─────────────────────────────────────────────────
 *
 * Over LM Studio REST v1 (`LmStudioEngineClient.load`): documented keys only,
 * list-before-load, serialised per engine. TASK-996 shipped a 501 here because
 * the REST load "failed for every payload"; the TASK-1005 Phase 0 spike traced
 * that to the strict schema (`ttl` / `identifier` / `gpu` answer 400
 * `unrecognized_keys`) and loaded fine with the documented keys.
 *
 * REST v1 carries only the context window and flash attention out of the
 * serving profile. Decode slots, KV-cache quantization and GPU placement have
 * no REST key: a gateway load gets the engine's own defaults for them (the pod's
 * `LMS_PARALLEL` and `LMS_GPU_SPLIT_STRATEGY`), and the response's `loadConfig`
 * is the engine's own echo of what it applied — never the requested profile.
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
    const profile = this.resolveProfile(entity, await this.platformDefault(), request);

    const snapshot = await this.engine.snapshot();
    const listed = snapshot.models.find((model) => model.modelKey === modelKey);
    const resident = (listed?.instances.length ?? 0) > 0;
    if (request.force !== true && !resident) await this.assertFitsOneCard(loadEstimateBytes(listed?.weightsBytes ?? 0, profile));

    const result = await this.engine.load(modelKey, this.restOptions(profile, request)).catch((error: unknown) => {
      throw toHttpException(error);
    });
    const model = { ...result.model, aiModelId: entity.id };

    if (result.outcome === 'loaded') {
      // A platform-disruptive action on shared, time-sliced cards has to stay
      // attributable to the administrator who took it. A no-op (already
      // resident) changed nothing, so it is not announced as a change.
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        data: { engine: 'lm-studio', action: 'load', modelKey, instanceId: model.instanceId, loadSeconds: model.loadSeconds },
      });
    }
    return { outcome: result.outcome, model };
  }

  async unload(identifier: string): Promise<UnloadLmStudioModelResponse> {
    this.assertPlatformAdmin('unload a model');

    const snapshot = await this.engine.snapshot();
    const known = snapshot.models.some((model) => model.instances.some((instance) => instance.identifier === identifier));
    if (!known) throw new NotFoundException(`No LM Studio instance named '${identifier}' is loaded.`);

    const result = await this.engine.unload(identifier).catch((error: unknown) => {
      throw toHttpException(error);
    });
    if (result.outcome === 'not_loaded') throw new NotFoundException(`No LM Studio instance named '${identifier}' is loaded.`);

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
   * The request can only speak for the two profile fields REST v1 carries
   * (`contextLength`, `flashAttention`); the whole resolved profile is still
   * checked for coherence and still feeds the VRAM estimate.
   */
  private resolveProfile(
    entity: Parameters<typeof servingProfileOf>[0],
    platformDefault: AiModelServingProfile,
    request: LoadLmStudioModelRequest,
  ): AiModelServingProfile {
    const declaredContextLength = declaredContextLengthOf(entity);
    const base = resolveServingProfile(servingProfileOf(entity), platformDefault, { declaredContextLength });

    const requested: AiModelServingProfile = {};
    if (request.contextLength !== undefined) requested.contextLength = request.contextLength;
    if (request.flashAttention !== undefined) requested.flashAttention = request.flashAttention;

    const merged = resolveServingProfile(requested, base.profile, { declaredContextLength });
    if (merged.problems.length > 0) throw new BadRequestException({ problems: merged.problems });
    return merged.profile;
  }

  /** The REST v1 load options: the resolved window and flash attention, plus the pass-through REST knobs the caller set. */
  private restOptions(profile: AiModelServingProfile, request: LoadLmStudioModelRequest): LmStudioLoadOptions {
    const options: LmStudioLoadOptions = {};
    if (profile.contextLength !== undefined) options.contextLength = profile.contextLength;
    if (profile.flashAttention !== undefined) options.flashAttention = profile.flashAttention;
    if (request.evalBatchSize !== undefined) options.evalBatchSize = request.evalBatchSize;
    if (request.numExperts !== undefined) options.numExperts = request.numExperts;
    if (request.offloadKvCacheToGpu !== undefined) options.offloadKvCacheToGpu = request.offloadKvCacheToGpu;
    return options;
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

/**
 * The adapter's typed failures as HTTP. The `code` rides in the body so the
 * console (and the residency controller's callers) can branch on it.
 */
function toHttpException(error: unknown): unknown {
  if (!(error instanceof LmStudioEngineError)) return error;
  const body = { code: error.code, message: error.message };
  switch (error.code) {
    case 'LOAD_IN_PROGRESS':
      return new ConflictException(body);
    case 'MODEL_UNKNOWN':
      return new NotFoundException(body);
    case 'ENGINE_NOT_CONFIGURED':
    case 'ENGINE_UNREACHABLE':
      return new ServiceUnavailableException(body);
    case 'LOAD_FAILED':
    case 'UNLOAD_FAILED':
      return new BadGatewayException(body);
    default:
      return new HttpException(body, 500);
  }
}

/** Re-exported so a caller can type the engine read without importing the client module. */
export type { LmStudioSnapshot };
