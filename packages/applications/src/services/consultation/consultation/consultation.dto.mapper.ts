import { ConsultationEntity, ContextItemEntity, UserEntity, DepartmentEntity } from '@arcaai/domains';
import { ConsultationResponse, DoctorInfo, DepartmentInfo, CONSULTATION_STATUS } from './dto';
import { ContextDtoMapper } from '../context/context.dto.mapper';

/**
 * Consultation DTO Mapper
 *
 * Maps ConsultationEntity to response DTOs
 */
export class ConsultationDtoMapper {
  /**
   * Convert entity to response
   */
  static toResponse(entity: ConsultationEntity, isNew = false): ConsultationResponse {
    const metadata = entity.metadata as Record<string, unknown> | null | undefined;
    // Lifecycle status precedence:
    //   • TASK-330 promoted status to a typed `status` COLUMN; the attestation
    //     gate writes it (harness draft → PENDING_REVIEW, approve → SIGNED). An
    //     explicit non-OPEN column value is canonical and wins.
    //   • TASK-322 close/reopen still write the legacy `metadata.status` JSON.
    //     The column default is OPEN ("not yet transitioned"), so when the
    //     column is OPEN/absent we defer to metadata.status, then OPEN.
    const columnStatus = entity.status as string | undefined;
    const metaStatus = metadata?.status as string | undefined;
    const status =
      columnStatus && columnStatus !== CONSULTATION_STATUS.OPEN
        ? columnStatus
        : (metaStatus ?? columnStatus ?? CONSULTATION_STATUS.OPEN);

    return {
      id: entity.id,
      patientId: entity.patientId,
      doctorId: entity.doctorId,
      doctor: entity.Doctor ? this.mapDoctor(entity.Doctor) : undefined,
      departmentId: entity.departmentId ?? undefined,
      department: entity.Department ? this.mapDepartment(entity.Department) : undefined,
      appointmentDate: entity.appointmentDate.toISOString().split('T')[0],
      parentConsultationId: entity.parentConsultationId ?? undefined,
      status,
      metadata: entity.metadata as Record<string, unknown> | undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      isNew,
    };
  }

  /**
   * Convert entity to response with context items
   */
  static toResponseWithContext(entity: ConsultationEntity, isNew = false): ConsultationResponse {
    const response = this.toResponse(entity, isNew);

    if (entity.ContextItems && entity.ContextItems.length > 0) {
      response.contextItems = entity.ContextItems.map((item: ContextItemEntity) => ContextDtoMapper.toResponse(item));
    }

    return response;
  }

  /**
   * Map Doctor (User) entity to DoctorInfo
   */
  private static mapDoctor(user: UserEntity): DoctorInfo {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = (user as any).UserProfile;
    return {
      id: user.id,
      username: user.username,
      firstName: profile?.firstName ?? undefined,
      lastName: profile?.lastName ?? undefined,
    };
  }

  /**
   * Map Department entity to DepartmentInfo
   */
  private static mapDepartment(department: DepartmentEntity): DepartmentInfo {
    return {
      id: department.id,
      code: department.code ?? undefined,
      name: department.name ?? undefined,
    };
  }
}
