/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserProfileEntity, IUserProfileEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateUserProfileProps extends BaseEntityFactoryCreateProps {
    firstName?: IUserProfileEntity['firstName'];
    lastName?: IUserProfileEntity['lastName'];
    email?: IUserProfileEntity['email'];
    phone?: IUserProfileEntity['phone'];
    avatarId?: IUserProfileEntity['avatarId'];
    userId: IUserProfileEntity['userId'];
    User?: IUserProfileEntity['User'];

    createdAt?: IUserProfileEntity['createdAt'];
    updatedAt?: IUserProfileEntity['updatedAt'];
    createdBy?: IUserProfileEntity['createdBy'];
    updatedBy?: IUserProfileEntity['updatedBy'];
}

export class UserProfileFactory {
    static CreateUserProfile(props: CreateUserProfileProps): UserProfileEntity {
        const id = generateId();
        const now = new Date();

        return new UserProfileEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            firstName: props.firstName ?? "",
            lastName: props.lastName ?? "",
            email: props.email ?? "",
            phone: props.phone ?? "",
            avatarId: props.avatarId ?? "",
            userId: props.userId,
            User: props.User ?? null,
        });
    }
}