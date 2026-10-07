import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { GuardrailPolicyRevisionEntityMapper } from '../../../mappers';
import { GuardrailPolicyRevisionEntity } from '../../../entities';
import { GuardrailPolicyRevision } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

const NEWEST_FIRST = [{ at: 'desc' }, { id: 'desc' }];

/**
 * TASK-1050 — append-only history of platform guardrail policy values
 * (§11.3 B/C). SYSTEM-tenant rows, written with the inherited `create` in a
 * SYSTEM/tenant-less context; never updated or deleted.
 */
@Injectable()
export class GuardrailPolicyRevisionRepository extends Repository<GuardrailPolicyRevisionEntity, GuardrailPolicyRevision> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'guardrailPolicyRevision', GuardrailPolicyRevisionEntityMapper.getInstance());
  }

  /** The revisions of one policy key on one model row, newest first, at most `limit`. */
  async listByKey(aiModelId: string, policyKey: string, limit: number): Promise<GuardrailPolicyRevisionEntity[]> {
    const models = await (this as any).db.findMany({ where: { aiModelId, policyKey }, orderBy: NEWEST_FIRST, take: limit });
    return models.map((model: GuardrailPolicyRevision) => (this as any)._mapper.toDomainEntity(model));
  }

  /** The newest revision of one policy key, or `null` when it was never revised. */
  async findLatestByKey(aiModelId: string, policyKey: string): Promise<GuardrailPolicyRevisionEntity | null> {
    const model = await (this as any).db.findFirst({ where: { aiModelId, policyKey }, orderBy: NEWEST_FIRST });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }
}
