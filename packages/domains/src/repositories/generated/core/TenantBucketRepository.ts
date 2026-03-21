import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantBucketEntityMapper } from '../../../mappers';
import { TenantBucketEntity } from '../../../entities';
import { TenantBucket } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType, TenantBucketType } from '../../../enums';

@Injectable()
export class TenantBucketRepository extends Repository<TenantBucketEntity, TenantBucket> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'tenantBucket', TenantBucketEntityMapper.getInstance());
    }

    async findAllByTenant(tenantId: string, options?: { includeDisabled?: boolean }): Promise<TenantBucketEntity[]> {
        const filters: Record<string, unknown> = { tenantId };
        if (!options?.includeDisabled) {
            filters.resourceStatus = ResourceStatusType.ENABLED;
        }
        return this.findAll({
            filters,
            sort: [{ slug: 'asc' }],
        });
    }

    async findBySlug(tenantId: string, slug: string): Promise<TenantBucketEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    tenantId,
                    slug,
                    resourceStatus: ResourceStatusType.ENABLED,
                },
            });
        } catch {
            return null;
        }
    }

    async findByName(name: string): Promise<TenantBucketEntity | null> {
        try {
            return await this.findFirst({
                filters: {
                    name,
                    resourceStatus: ResourceStatusType.ENABLED,
                },
            });
        } catch {
            return null;
        }
    }

    async findSystemBuckets(tenantId: string): Promise<TenantBucketEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                bucketType: TenantBucketType.SYSTEM,
                resourceStatus: ResourceStatusType.ENABLED,
            },
            sort: [{ slug: 'asc' }],
        });
    }

    async findCustomBuckets(tenantId: string): Promise<TenantBucketEntity[]> {
        return this.findAll({
            filters: {
                tenantId,
                bucketType: TenantBucketType.CUSTOM,
                resourceStatus: ResourceStatusType.ENABLED,
            },
            sort: [{ slug: 'asc' }],
        });
    }
}
