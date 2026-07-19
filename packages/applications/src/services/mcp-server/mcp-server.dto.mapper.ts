import { McpServerEntity } from '@arcaai/domains';
import { McpServerListResponse, McpServerResponse } from './dto';

export class McpServerDtoMapper {
  static toResponse(entity: McpServerEntity): McpServerResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      name: entity.name,
      description: entity.description ?? null,
      baseUrl: entity.baseUrl,
      transport: entity.transport,
      // authRef is a Vault PATH (not secret material) — safe to echo.
      authRef: entity.authRef ?? null,
      toolAllowlist: (entity.toolAllowlist as string[] | null | undefined) ?? null,
      phiBoundary: entity.phiBoundary,
      enabled: entity.enabled,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }

  static toListResponse(entities: McpServerEntity[]): McpServerListResponse {
    const items = entities.map((e) => McpServerDtoMapper.toResponse(e));
    return { items, total: items.length };
  }
}
