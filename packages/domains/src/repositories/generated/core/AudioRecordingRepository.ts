import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AudioRecordingEntityMapper } from '../../../mappers';
import { AudioRecordingEntity } from '../../../entities';
import { AudioRecording } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class AudioRecordingRepository extends Repository<AudioRecordingEntity, AudioRecording> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'audioRecording', AudioRecordingEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all audio recordings for a context item
   */
  async findByContextItem(contextItemId: string): Promise<AudioRecordingEntity[]> {
    const models = await (this as any).db.findMany({
      where: { contextItemId },
      orderBy: { sequenceNumber: 'asc' },
    });

    return models.map((model: AudioRecording) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find audio recording by media ID
   */
  async findByMediaId(mediaId: string): Promise<AudioRecordingEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: { mediaId },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Get the next sequence number for a context item
   */
  async getNextSequenceNumber(contextItemId: string): Promise<number> {
    const result = await (this as any).db.aggregate({
      where: { contextItemId },
      _max: { sequenceNumber: true },
    });
    return (result._max.sequenceNumber ?? 0) + 1;
  }

  /**
   * Find audio recordings by tenant
   */
  async findByTenant(tenantId: string, limit: number = 100): Promise<AudioRecordingEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return models.map((model: AudioRecording) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Count audio recordings for a context item
   */
  async countByContextItem(contextItemId: string): Promise<number> {
    return (this as any).db.count({
      where: { contextItemId },
    });
  }

  /**
   * Find audio recordings by format
   */
  async findByFormat(format: string, limit: number = 100): Promise<AudioRecordingEntity[]> {
    const models = await (this as any).db.findMany({
      where: { format },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return models.map((model: AudioRecording) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Get total duration for a context item (in milliseconds)
   */
  async getTotalDuration(contextItemId: string): Promise<number> {
    const result = await (this as any).db.aggregate({
      where: { contextItemId },
      _sum: { duration: true },
    });
    return result._sum.duration ?? 0;
  }

  /**
   * SUM(duration) in milliseconds for the platform consumption
   * roll-up. `tenantId = null` means platform-wide (no tenant
   * filter). Returns the raw nullable sum — the caller owns the null→0
   * presentation.
   */
  async sumDurationForTenant(tenantId: string | null): Promise<number | null> {
    const result = await (this as any).db.aggregate({
      _sum: { duration: true },
      where: tenantId ? { tenantId } : {},
    });
    return result._sum.duration;
  }
}
