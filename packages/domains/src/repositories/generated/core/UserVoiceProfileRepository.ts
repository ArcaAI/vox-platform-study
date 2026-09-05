import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { UserVoiceProfileEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { UserVoiceProfileEntityMapper } from '../../../mappers';
import { UserVoiceProfile } from '../../../models';

/**
 * One enrolled profile as the ASR runtime consumes it (TASK-887): the vector, the label to
 * stamp on a matched segment, and the model that produced the vector so the runtime can
 * re-check the space it was told to match in.
 */
export interface UserVoiceProfileEmbeddingRow {
  id: string;
  label: string | null;
  modelId: string;
  embedding: number[];
}

@Injectable()
export class UserVoiceProfileRepository extends Repository<UserVoiceProfileEntity, UserVoiceProfile> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'userVoiceProfile', UserVoiceProfileEntityMapper.getInstance());
  }

  async findAllByUserId(userId: string): Promise<UserVoiceProfileEntity[]> {
    return this.findAll({
      filters: {
        userId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  async findActiveByUserId(userId: string): Promise<UserVoiceProfileEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          userId,
          isActive: true,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  async deactivateAllForUser(userId: string): Promise<void> {
    await (this as any).db.updateMany({
      where: {
        userId,
        isActive: true,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });
  }

  async activateById(id: string): Promise<void> {
    await (this as any).db.update({
      where: { id },
      data: {
        isActive: true,
        updatedAt: new Date(),
      },
    });
  }

  async createWithEmbedding(entity: UserVoiceProfileEntity, embedding: number[]): Promise<UserVoiceProfileEntity> {
    if (!embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Invalid embedding: all values must be finite numbers');
    }
    const vectorStr = `[${embedding.join(',')}]`;
    const client = this.unitOfWorkService.getDatabaseService();
    const now = new Date();
    await (client as any).$executeRawUnsafe(
      `INSERT INTO "core"."UserVoiceProfile"
        ("id", "tenantId", "userId", "embedding", "isActive", "label", "modelId",
         "resourceStatus", "createdBy", "updatedBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8::"core"."ResourceStatusType", $9, $10, $11, $12)`,
      entity.id,
      entity.tenantId,
      entity.userId,
      vectorStr,
      entity.isActive,
      entity.label ?? null,
      entity.modelId,
      entity.resourceStatus,
      entity.createdBy ?? null,
      entity.updatedBy ?? null,
      entity.createdAt ?? now,
      entity.updatedAt ?? now,
    );
    return entity;
  }

  /**
   * TASK-887 — the user's ACTIVE enrolled profiles in ONE embedding model's space.
   *
   * Raw SQL because `embedding` is `Unsupported("vector")` and therefore invisible to the
   * typed client — the same reason `createWithEmbedding` above is raw. Raw queries also
   * bypass the tenant-scope extension, so `tenantId` is an explicit predicate here: a voice
   * profile is biometric PHI and a cross-tenant read must return nothing, not everything.
   *
   * `modelId` is a REQUIRED argument, never optional: matching a profile against a model that
   * did not produce it compares two unrelated vector spaces, so "all of this user's profiles"
   * is not a question this method is willing to answer.
   */
  async findActiveEmbeddingsForUser(userId: string, tenantId: string, modelId: string): Promise<UserVoiceProfileEmbeddingRow[]> {
    if (!userId || !tenantId || !modelId) return [];
    const client = this.unitOfWorkService.getDatabaseService();
    const rows = await (client as any).$queryRawUnsafe(
      `SELECT "id", "label", "modelId", "embedding"::text AS embedding
         FROM "core"."UserVoiceProfile"
        WHERE "userId" = $1
          AND "tenantId" = $2
          AND "modelId" = $3
          AND "isActive" = true
          AND "resourceStatus" = 'ENABLED'
        ORDER BY "createdAt" DESC`,
      userId,
      tenantId,
      modelId,
    );
    return (rows as Array<{ id: string; label: string | null; modelId: string; embedding: string | null }>).flatMap((row) => {
      const parsed = parseVector(row.embedding);
      return parsed.length > 0 ? [{ id: row.id, label: row.label, modelId: row.modelId, embedding: parsed }] : [];
    });
  }
}

/** `'[0.1,0.2,…]'` (pgvector's text form) → `number[]`; `[]` for anything unparseable. */
function parseVector(text: string | null): number[] {
  if (typeof text !== 'string') return [];
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!body) return [];
  const values = body.split(',').map((part) => Number.parseFloat(part));
  return values.every((n) => Number.isFinite(n)) ? values : [];
}
