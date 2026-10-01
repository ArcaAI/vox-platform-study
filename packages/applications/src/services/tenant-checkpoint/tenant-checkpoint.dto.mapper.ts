import type { TenantCheckpointEntity, TenantCheckpointRestoreEntity } from '@arcaai/domains';
import type {
  CheckpointProgressResponse,
  PaginatedTenantCheckpointResponse,
  PaginatedTenantCheckpointRestoreResponse,
  RestoreCountResponse,
  RestoreWarningResponse,
  TenantCheckpointResponse,
  TenantCheckpointRestoreResponse,
} from './dto';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function progressOf(value: unknown): CheckpointProgressResponse | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  return {
    phase: String(p.phase ?? ''),
    tablesDone: Number(p.tablesDone ?? 0),
    tablesTotal: Number(p.tablesTotal ?? 0),
    bytesWritten: Number(p.bytesWritten ?? 0),
  };
}

/** Entity → response. `keyEnvelope`, `objectKey`, `uploadId` and the manifest never leave the service. */
export class TenantCheckpointDtoMapper {
  static toResponse(entity: TenantCheckpointEntity): TenantCheckpointResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      label: entity.label,
      kind: entity.kind,
      origin: entity.origin,
      status: entity.status,
      includesMedia: entity.includesMedia,
      passphraseProtected: entity.passphraseProtected,
      sizeBytes: entity.sizeBytes ?? null,
      progress: progressOf(entity.progress),
      createdAt: entity.createdAt.toISOString(),
      createdBy: entity.createdBy ?? null,
      expiresAt: iso(entity.expiresAt),
      heartbeatAt: iso(entity.heartbeatAt),
      failureReason: entity.failureReason ?? null,
      failureDetail: entity.failureDetail ?? null,
      version: entity.version,
    };
  }

  static toRestoreResponse(entity: TenantCheckpointRestoreEntity): TenantCheckpointRestoreResponse {
    return {
      id: entity.id,
      checkpointId: entity.checkpointId,
      categories: [...entity.categories] as TenantCheckpointRestoreResponse['categories'],
      reason: entity.reason,
      status: entity.status,
      safetyCheckpointId: entity.safetyCheckpointId ?? null,
      counts: Array.isArray(entity.counts) ? (entity.counts as unknown as RestoreCountResponse[]) : null,
      warnings: Array.isArray(entity.warnings) ? (entity.warnings as unknown as RestoreWarningResponse[]) : [],
      requestedBy: entity.requestedBy,
      createdAt: entity.createdAt.toISOString(),
      lockAcquiredAt: iso(entity.lockAcquiredAt),
      lockReleasedAt: iso(entity.lockReleasedAt),
      failureReason: entity.failureReason ?? null,
      failureDetail: entity.failureDetail ?? null,
      version: entity.version,
    };
  }

  static toPaginatedResponse(rows: TenantCheckpointEntity[], count: number, page: number, limit: number): PaginatedTenantCheckpointResponse {
    return { count, page, limit, data: rows.map((r) => TenantCheckpointDtoMapper.toResponse(r)) };
  }

  static toPaginatedRestoreResponse(
    rows: TenantCheckpointRestoreEntity[],
    count: number,
    page: number,
    limit: number,
  ): PaginatedTenantCheckpointRestoreResponse {
    return { count, page, limit, data: rows.map((r) => TenantCheckpointDtoMapper.toRestoreResponse(r)) };
  }
}
