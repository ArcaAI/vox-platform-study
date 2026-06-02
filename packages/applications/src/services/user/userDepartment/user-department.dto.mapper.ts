import { UserDepartmentEntity } from '@arcaai/domains';
import { UserDepartmentResponse } from './dto';

export class UserDepartmentDtoMapper {
  static toResponse(entity: UserDepartmentEntity): UserDepartmentResponse {
    return {
      id: entity.id,
      userId: entity.userId,
      departmentId: entity.departmentId,
      isPrimary: entity.isPrimary,
      tenantId: entity.tenantId,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
