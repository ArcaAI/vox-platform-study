import { UserDepartmentEntity } from '@arcaai/domains';
import { UserDepartmentResponse } from './dto';

export class UserDepartmentDtoMapper {
  // The optional `department` arg carries the human-readable label
  // data (name/code) resolved by the caller; when provided its non-null values
  // are surfaced so the admin console renders names instead of raw UUIDs.
  static toResponse(entity: UserDepartmentEntity, department?: { name?: string | null; code?: string | null }): UserDepartmentResponse {
    return {
      id: entity.id,
      userId: entity.userId,
      departmentId: entity.departmentId,
      departmentName: department?.name ?? undefined,
      departmentCode: department?.code ?? undefined,
      isPrimary: entity.isPrimary,
      tenantId: entity.tenantId,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
