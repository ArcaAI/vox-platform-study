/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { FederatedIdentityEntity, IFederatedIdentityEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateFederatedIdentityProps extends BaseEntityFactoryCreateProps {
  tenantId: IFederatedIdentityEntity['tenantId'];
  userId: IFederatedIdentityEntity['userId'];
  providerId: IFederatedIdentityEntity['providerId'];
  subject: IFederatedIdentityEntity['subject'];
  lastLoginAt?: IFederatedIdentityEntity['lastLoginAt'];

  createdAt?: IFederatedIdentityEntity['createdAt'];
  updatedAt?: IFederatedIdentityEntity['updatedAt'];
  createdBy?: IFederatedIdentityEntity['createdBy'];
  updatedBy?: IFederatedIdentityEntity['updatedBy'];
}

export class FederatedIdentityFactory {
  static CreateFederatedIdentity(props: CreateFederatedIdentityProps): FederatedIdentityEntity {
    const id = generateId();
    const now = new Date();

    return new FederatedIdentityEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      userId: props.userId,
      providerId: props.providerId,
      subject: props.subject,
      lastLoginAt: props.lastLoginAt ?? null,
    });
  }
}
