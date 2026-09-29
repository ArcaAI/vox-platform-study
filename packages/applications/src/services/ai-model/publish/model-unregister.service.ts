/**
 * The worker half of "unregister a model" (TASK-1019 OD-2, D-5, D-6).
 *
 * The gateway has already done the checks that need the whole platform —
 * referrers (409 `MODEL_IN_USE`), residency unload — and written
 * `_metadata.unregister.startedAt`. This runs on the model-publisher worker
 * because only the worker holds a delete-capable key on `hope-models` (D-2).
 *
 * Order of effects, and why:
 *   1. weights — deleted (or purged) unless `deleteWeights` is false, or
 *      another non-deleted row still references the prefix (D-6: two rows may
 *      wrap one repo at different revisions / compute types) → `kept-shared`;
 *   2. bookkeeping — availability MISSING (when deleted), `_metadata.unregister`
 *      completed — written while the row is still live and OCC-writable;
 *   3. the row soft-deleted, then `ResourceDeleted` broadcast.
 * A failure anywhere records the error (on the final attempt) and leaves the
 * row registered: a half-unregistered row that still exists is recoverable, a
 * soft-deleted row whose weights are still present is an orphan nobody sees.
 */
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AiModelAvailability, AiModelRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService, assertEqualTenants } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { mergeUnregisterMeta } from './model-download-meta.util';
import { ModelStoreFactory } from './model-store';
import type { UnregisterAiModelJobPayload, UnregisterWeightsOutcome } from './publisher-job.contract';

export interface UnregisterAiModelResult {
  aiModelId: string;
  bucketPrefix: string | null;
  weights: UnregisterWeightsOutcome;
  deletedObjects: number;
  deletedVersions: number;
}

const HF_REPO_DIR_RE = /^(hf\/hub\/models--[^/]+--[^/]+\/)/;
/** Layout roots — a derivation that lands on one of these deletes nothing. */
const LAYOUT_ROOTS: ReadonlySet<string> = new Set(['/', 'hf/', 'hf/hub/']);

/**
 * The bucket directory that holds a row's weights:
 *   HF cache  `hf/hub/models--<org>--<repo>/snapshots/<sha>/` → `hf/hub/models--<org>--<repo>/`
 *             (the repo directory: `refs/main` + every snapshot — nothing else can use them)
 *   flat      `<slug>/<version>/` → itself
 * `null` when the row names no prefix, or only a layout root.
 */
export function deriveWeightsPrefix(bucketPrefix: string | null | undefined): string | null {
  const raw = bucketPrefix?.trim();
  if (!raw) return null;
  const hf = raw.match(HF_REPO_DIR_RE);
  const prefix = hf ? hf[1] : raw.endsWith('/') ? raw : `${raw}/`;
  if (prefix.startsWith('/') || LAYOUT_ROOTS.has(prefix)) return null;
  return prefix;
}

/** Every proper ancestor directory of `prefix` (`a/b/c/` → `a/`, `a/b/`). */
function ancestorPrefixes(prefix: string): string[] {
  const parts = prefix.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

@Injectable()
export class AiModelUnregisterService extends BaseService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    private readonly modelStoreFactory: ModelStoreFactory,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * Run one unregister job. Must be called inside the job's CLS context (the
   * processor binds it). `finalAttempt` decides whether a failure is recorded
   * on the row now, or left for the BullMQ retry.
   */
  async execute(payload: UnregisterAiModelJobPayload, opts: { finalAttempt: boolean }): Promise<UnregisterAiModelResult> {
    const { jobId, aiModelId, tenantId, userId, deleteWeights, purge } = payload;

    const model = await this.aiModelRepository.findByIdOrNull(aiModelId);
    if (!model) throw new Error(`AiModel ${aiModelId} not found`);
    assertEqualTenants(model, { tenantId });

    const bucketPrefix = model.bucketPrefix ?? null;

    try {
      let weights: UnregisterWeightsOutcome = 'kept';
      let counts = { objects: 0, versions: 0 };

      if (deleteWeights) {
        const prefix = deriveWeightsPrefix(bucketPrefix);
        if (!prefix) {
          weights = 'deleted'; // nothing was ever published for this row
        } else if (await this.isPrefixShared(aiModelId, prefix)) {
          weights = 'kept-shared';
        } else {
          const store = await this.modelStoreFactory.create();
          counts = await store.deletePrefix(prefix, { purge });
          weights = 'deleted';
        }
      }

      const fresh = await this.aiModelRepository.findById(aiModelId);
      if (weights === 'deleted') fresh.markAvailability(AiModelAvailability.MISSING, null);
      fresh.metaData = mergeUnregisterMeta(fresh.metaData, {
        jobId,
        deleteWeights,
        purge,
        finishedAt: new Date().toISOString(),
        error: null,
        weights,
        deletedObjects: counts.objects,
        deletedVersions: counts.versions,
      });
      if (userId) fresh.updatedBy = userId;
      await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);
      await this.aiModelRepository.softDelete(aiModelId, userId);

      this.broadcastSysEvent(SysEventType.ResourceDeleted, {
        resourceId: aiModelId,
        data: { weights, purge, bucketPrefix, deletedObjects: counts.objects, deletedVersions: counts.versions, jobId },
      });

      return { aiModelId, bucketPrefix, weights, deletedObjects: counts.objects, deletedVersions: counts.versions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fresh = await this.aiModelRepository.findByIdOrNull(aiModelId);
      if (fresh) {
        fresh.metaData = opts.finalAttempt
          ? mergeUnregisterMeta(fresh.metaData, { jobId, deleteWeights, purge, finishedAt: new Date().toISOString(), error: message })
          : mergeUnregisterMeta(fresh.metaData, { jobId, deleteWeights, purge, finishedAt: null, error: null });
        if (userId) fresh.updatedBy = userId;
        await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);
      }
      throw error;
    }
  }

  /**
   * Whether another NON-deleted row (the soft-delete extension hides deleted
   * ones) still needs any object under `prefix`: its own prefix lies inside
   * `prefix`, or `prefix` lies inside its prefix.
   */
  private async isPrefixShared(aiModelId: string, prefix: string): Promise<boolean> {
    const others = await this.aiModelRepository.findAll({
      where: {
        id: { not: aiModelId },
        OR: [{ bucketPrefix: { startsWith: prefix } }, { bucketPrefix: { in: ancestorPrefixes(prefix) } }],
      },
    } as never);
    return others.length > 0;
  }
}
