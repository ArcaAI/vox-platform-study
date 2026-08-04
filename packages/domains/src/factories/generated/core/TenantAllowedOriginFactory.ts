/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantAllowedOriginEntity, TenantAllowedOriginEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantAllowedOriginProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantAllowedOriginEntity['tenantId'];
  /** Pre-normalized `scheme://host[:port]` — caller runs `normalizeOrigin` first. */
  origin: ITenantAllowedOriginEntity['origin'];
  label: ITenantAllowedOriginEntity['label'];
  description?: ITenantAllowedOriginEntity['description'];

  createdAt?: ITenantAllowedOriginEntity['createdAt'];
  updatedAt?: ITenantAllowedOriginEntity['updatedAt'];
  createdBy?: ITenantAllowedOriginEntity['createdBy'];
  updatedBy?: ITenantAllowedOriginEntity['updatedBy'];
}

export class TenantAllowedOriginFactory {
  static CreateTenantAllowedOrigin(props: CreateTenantAllowedOriginProps): TenantAllowedOriginEntity {
    const id = generateId();
    const now = new Date();

    return new TenantAllowedOriginEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      origin: props.origin,
      label: props.label,
      description: props.description ?? null,
    });
  }
}
