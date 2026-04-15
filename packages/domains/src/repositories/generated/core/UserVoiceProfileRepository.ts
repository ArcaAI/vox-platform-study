import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { UserVoiceProfileEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { UserVoiceProfileEntityMapper } from '../../../mappers';
import { UserVoiceProfile } from '../../../models';

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
    const vectorStr = `[${embedding.join(',')}]`;
    const client = this.unitOfWorkService.getDatabaseService();
    const now = new Date();
    await (client as any).$executeRawUnsafe(
      `INSERT INTO "core"."UserVoiceProfile"
        ("id", "userId", "embedding", "isActive", "label", "modelId",
         "resourceStatus", "createdBy", "updatedBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7::"core"."ResourceStatusType", $8, $9, $10, $11)`,
      entity.id,
      entity.userId,
      vectorStr,
      entity.isActive,
      entity.label ?? null,
      entity.modelId ?? null,
      entity.resourceStatus,
      entity.createdBy ?? null,
      entity.updatedBy ?? null,
      entity.createdAt ?? now,
      entity.updatedAt ?? now,
    );
    return entity;
  }

  async updateEmbeddingRaw(id: string, embedding: number[]): Promise<void> {
    const vectorStr = `[${embedding.join(',')}]`;
    const client = this.unitOfWorkService.getDatabaseService();
    await (client as any).$executeRawUnsafe(
      `UPDATE "core"."UserVoiceProfile" SET "embedding" = $1::vector, "updatedAt" = NOW() WHERE "id" = $2`,
      vectorStr,
      id,
    );
  }
}
