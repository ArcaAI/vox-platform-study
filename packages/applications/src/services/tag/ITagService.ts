import { EntityId, TagEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateTagRequest, UpdateTagRequest } from './dto';

// TODO: Implement this

export interface ITagService extends IBaseService {
    create(request: CreateTagRequest): Promise<TagEntity>;
    fetchAll(props: PaginatedQuery): Promise<FetchResponse<TagEntity>>;
    fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<TagEntity>>;
    fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<TagEntity>>;
    fetchById(id: EntityId): Promise<TagEntity>;
    update(id: EntityId, request: UpdateTagRequest): Promise<TagEntity>;
    deleteById(id: EntityId): Promise<TagEntity>;
}
export const ITagService = Symbol('ITagService');
