/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TagEntity, ITagEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateTagProps extends BaseEntityFactoryCreateProps {
  resourceTypeName?: ITagEntity['resourceTypeName'];
  resourceId?: ITagEntity['resourceId'];
  tagKey?: ITagEntity['tagKey'];
  tagValue: ITagEntity['tagValue'];
  description?: ITagEntity['description'];
  color?: ITagEntity['color'];
  icon?: ITagEntity['icon'];
  tenantId?: ITagEntity['tenantId'];
  Tenant?: ITagEntity['Tenant'];

  createdAt?: ITagEntity['createdAt'];
  updatedAt?: ITagEntity['updatedAt'];
  createdBy?: ITagEntity['createdBy'];
  updatedBy?: ITagEntity['updatedBy'];
}

export class TagFactory {
  static CreateTag(props: CreateTagProps): TagEntity {
    const id = generateId();
    const now = new Date();

    return new TagEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      resourceTypeName: props.resourceTypeName ?? '',
      resourceId: props.resourceId ?? '',
      tagKey: props.tagKey ?? '',
      tagValue: props.tagValue,
      description: props.description ?? '',
      color: props.color ?? '',
      icon: props.icon ?? '',
      tenantId: props.tenantId ?? '',
      Tenant: props.Tenant ?? null,
    });
  }
}
