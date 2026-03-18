import { EntityId, UserSettingsEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import {
    CreateUserSettingsRequest,
    UpdateUserSettingsRequest,
    UpdateUserSettingByKeyRequest,
} from './dto';

// TODO: Implement this

export interface IUserSettingsService extends IBaseService {
    create(request: CreateUserSettingsRequest): Promise<UserSettingsEntity>;
    fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserSettingsEntity>>;
    fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<UserSettingsEntity>>;
    fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<UserSettingsEntity>>;
    fetchAllByUserId(userId: string): Promise<UserSettingsEntity[]>;
    fetchById(id: EntityId): Promise<UserSettingsEntity>;
    update(
        id: EntityId,
        request: UpdateUserSettingsRequest
    ): Promise<UserSettingsEntity>;
    upsertByUserKeyNamespace(
        userId: string,
        namespace: string,
        key: string,
        request: UpdateUserSettingByKeyRequest
    ): Promise<UserSettingsEntity>;
    deleteById(id: EntityId): Promise<UserSettingsEntity>;
}
export const IUserSettingsService = Symbol('IUserSettingsService');
