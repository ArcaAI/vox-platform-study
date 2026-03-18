/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserEntity, IUserEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateUserProps extends BaseEntityFactoryCreateProps {
    username: IUserEntity['username'];
    password: IUserEntity['password'];
    lastLoginAt?: IUserEntity['lastLoginAt'];
    lastActiveAt?: IUserEntity['lastActiveAt'];
    externalId?: IUserEntity['externalId'];
    isServiceAccount: IUserEntity['isServiceAccount'];
    secret1?: IUserEntity['secret1'];
    secret1Expiry?: IUserEntity['secret1Expiry'];
    secret2?: IUserEntity['secret2'];
    secret2Expiry?: IUserEntity['secret2Expiry'];
    UserProfile?: IUserEntity['UserProfile'];
    UserSettings?: IUserEntity['UserSettings'];
    UserRoleAssignments?: IUserEntity['UserRoleAssignments'];
    UserNotifications?: IUserEntity['UserNotifications'];
    ResourceSubscriptions?: IUserEntity['ResourceSubscriptions'];
    UserMedias?: IUserEntity['UserMedias'];
    tags?: IUserEntity['tags'];
    Tags?: IUserEntity['Tags'];

    createdAt?: IUserEntity['createdAt'];
    updatedAt?: IUserEntity['updatedAt'];
    createdBy?: IUserEntity['createdBy'];
    updatedBy?: IUserEntity['updatedBy'];
}

export class UserFactory {
    static CreateUser(props: CreateUserProps): UserEntity {
        const id = generateId();
        const now = new Date();

        return new UserEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            username: props.username,
            password: props.password,
            lastLoginAt: props.lastLoginAt ?? new Date(),
            lastActiveAt: props.lastActiveAt ?? new Date(),
            externalId: props.externalId || null,
            isServiceAccount: props.isServiceAccount,
            secret1: props.secret1 ?? "",
            secret1Expiry: props.secret1Expiry ?? new Date(),
            secret2: props.secret2 ?? "",
            secret2Expiry: props.secret2Expiry ?? new Date(),
            UserProfile: props.UserProfile ?? null,
            UserSettings: props.UserSettings ?? [],
            UserRoleAssignments: props.UserRoleAssignments ?? [],
            UserNotifications: props.UserNotifications ?? [],
            ResourceSubscriptions: props.ResourceSubscriptions ?? [],
            UserMedias: props.UserMedias ?? [],
            tags: props.tags ?? [],
            Tags: props.Tags ?? [],
        });
    }
}