/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantEntity, ITenantEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateTenantProps extends BaseEntityFactoryCreateProps {
    name: ITenantEntity['name'];
    key: ITenantEntity['key'];
    description?: ITenantEntity['description'];
    tags?: ITenantEntity['tags'];
    Tags?: ITenantEntity['Tags'];

    createdAt?: ITenantEntity['createdAt'];
    updatedAt?: ITenantEntity['updatedAt'];
    createdBy?: ITenantEntity['createdBy'];
    updatedBy?: ITenantEntity['updatedBy'];
}

export class TenantFactory {
    static CreateTenant(props: CreateTenantProps): TenantEntity {
        const id = generateId();
        const now = new Date();

        return new TenantEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            name: props.name,
            key: props.key,
            description: props.description ?? "",
            tags: props.tags ?? [],
            Tags: props.Tags ?? [],
        });
    }
}