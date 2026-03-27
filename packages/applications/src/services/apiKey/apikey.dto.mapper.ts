import { ApiKeyEntity } from '@arcaai/domains';
import { ApiKeyResponse, PaginatedApiKeyResponse } from './dto';
import { FetchResponse } from '../../common';

export class ApiKeyDtoMapper {
  static ToResponse(entity: ApiKeyEntity): ApiKeyResponse {
    return new ApiKeyResponse({
      id: entity.id,
      keyName: entity.keyName,
      keyPrefix: entity.keyPrefix,
      keyType: entity.keyType,
      keyStatus: entity.keyStatus,
      scopes: entity.scopes as string[] | null,
      allowedIps: entity.allowedIps as string[] | null,
      rateLimit: entity.rateLimit,
      expiresAt: entity.expiresAt,
      lastUsedAt: entity.lastUsedAt,
      usageCount: entity.usageCount,
      description: entity.description,
      environment: entity.environment,
      userId: entity.userId,
      tenantId: entity.tenantId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      resourceStatus: entity.resourceStatus,
      resourceStatusUpdatedAt: entity.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: entity.resourceStatusUpdatedBy ?? '',
      createdBy: entity.createdBy,
      updatedBy: entity.updatedBy,
      projectId: null,
    });
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<ApiKeyEntity>): PaginatedApiKeyResponse {
    return new PaginatedApiKeyResponse({
      page,
      limit,
      count,
      data: data.map((apiKey) => this.ToResponse(apiKey)),
    });
  }
}
