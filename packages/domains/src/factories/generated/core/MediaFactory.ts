/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { MediaEntity, IMediaEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateMediaProps extends BaseEntityFactoryCreateProps {
  name: IMediaEntity['name'];
  uri: IMediaEntity['uri'];
  extension: IMediaEntity['extension'];
  mimeType: IMediaEntity['mimeType'];
  size: IMediaEntity['size'];
  hash: IMediaEntity['hash'];
  UserMedias?: IMediaEntity['UserMedias'];
  tenantId: IMediaEntity['tenantId'];
  Tenant?: IMediaEntity['Tenant'];
  tags?: IMediaEntity['tags'];
  Tags?: IMediaEntity['Tags'];

  createdAt?: IMediaEntity['createdAt'];
  updatedAt?: IMediaEntity['updatedAt'];
  createdBy?: IMediaEntity['createdBy'];
  updatedBy?: IMediaEntity['updatedBy'];
}

export class MediaFactory {
  static CreateMedia(props: CreateMediaProps): MediaEntity {
    const id = generateId();
    const now = new Date();

    return new MediaEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      uri: props.uri,
      extension: props.extension,
      mimeType: props.mimeType,
      size: props.size,
      hash: props.hash,
      UserMedias: props.UserMedias ?? [],
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
