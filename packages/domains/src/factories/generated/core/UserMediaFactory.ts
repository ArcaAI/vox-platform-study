/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserMediaEntity, IUserMediaEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateUserMediaProps extends BaseEntityFactoryCreateProps {
    sharedAt?: IUserMediaEntity['sharedAt'];
    userId: IUserMediaEntity['userId'];
    User?: IUserMediaEntity['User'];
    mediaId: IUserMediaEntity['mediaId'];
    Media?: IUserMediaEntity['Media'];
    tags?: IUserMediaEntity['tags'];
    Tags?: IUserMediaEntity['Tags'];

    createdAt?: IUserMediaEntity['createdAt'];
    updatedAt?: IUserMediaEntity['updatedAt'];
    createdBy?: IUserMediaEntity['createdBy'];
    updatedBy?: IUserMediaEntity['updatedBy'];
}

export class UserMediaFactory {
    static CreateUserMedia(props: CreateUserMediaProps): UserMediaEntity {
        const id = generateId();
        const now = new Date();

        return new UserMediaEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            sharedAt: props.sharedAt ?? new Date(),
            userId: props.userId,
            User: props.User ?? null,
            mediaId: props.mediaId,
            Media: props.Media ?? null,
            tags: props.tags ?? [],
            Tags: props.Tags ?? [],
        });
    }
}