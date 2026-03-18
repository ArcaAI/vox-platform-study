import { EntityId, MediaEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateMediaRequest, UpdateMediaRequest } from './dto';

// TODO: Implement this

export interface IMediaService extends IBaseService {
    create(request: CreateMediaRequest): Promise<MediaEntity>;
    fetchAll(props: PaginatedQuery): Promise<FetchResponse<MediaEntity>>;
    fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<MediaEntity>>;
    fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<MediaEntity>>;
    fetchById(id: EntityId): Promise<MediaEntity>;
    update(id: EntityId, request: UpdateMediaRequest): Promise<MediaEntity>;
    deleteById(id: EntityId): Promise<MediaEntity>;
}
export const IMediaService = Symbol('IMediaService');
