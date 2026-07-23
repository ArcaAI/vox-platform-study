/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GoldenSetEntity, IGoldenSetEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateGoldenSetProps extends BaseEntityFactoryCreateProps {
  name: IGoldenSetEntity['name'];
  description?: IGoldenSetEntity['description'];
  pinnedVersion?: IGoldenSetEntity['pinnedVersion'];
  departmentId?: IGoldenSetEntity['departmentId'];
  tenantId: IGoldenSetEntity['tenantId'];
  Tenant?: IGoldenSetEntity['Tenant'];

  createdAt?: IGoldenSetEntity['createdAt'];
  updatedAt?: IGoldenSetEntity['updatedAt'];
  createdBy?: IGoldenSetEntity['createdBy'];
  updatedBy?: IGoldenSetEntity['updatedBy'];
}

export class GoldenSetFactory {
  static CreateGoldenSet(props: CreateGoldenSetProps): GoldenSetEntity {
    const id = generateId();
    const now = new Date();

    return new GoldenSetEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      description: props.description ?? null,
      pinnedVersion: props.pinnedVersion ?? null,
      departmentId: props.departmentId ?? null,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
