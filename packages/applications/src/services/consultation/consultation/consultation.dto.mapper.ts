import { ConsultationEntity, ContextItemEntity, UserEntity, DepartmentEntity } from '@arcaai/domains';
import { ConsultationResponse, DoctorInfo, DepartmentInfo } from './dto';
import { readSummaryLanguage } from './summary-language';
import { governingRunOf } from '../governing-engine';
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
    // `Consultation.status` is now the SOLE lifecycle tracker.
    // The legacy `metadata.status` JSON key is deleted ; the
    // precedence dance this mapper used to do between the typed column and
    // that key is gone with it — the column is simply canonical.
    return {
      id: entity.id,
      patientId: entity.patientId,
      doctorId: entity.doctorId,
      doctor: entity.Doctor ? this.mapDoctor(entity.Doctor) : undefined,
      departmentId: entity.departmentId ?? undefined,
      department: entity.Department ? this.mapDepartment(entity.Department) : undefined,
      appointmentDate: entity.appointmentDate.toISOString().split('T')[0],
      parentConsultationId: entity.parentConsultationId ?? undefined,
      status: entity.status,
      // TASK-932 §3.7 — read through the ONE reader, so a malformed marker reads as absent here
      // exactly as it does on the prompt paths, and so promoting the storage to the
      // `Consultation.language` column is a change to `readSummaryLanguage` and nothing else.
      language: readSummaryLanguage(entity.metadata) ?? undefined,
      metadata: entity.metadata as Record<string, unknown> | undefined,
      // the OCC row version, so a client can build the `If-Match`
      // header the state-machine transition routes require. Also feeds
      // `ETagInterceptor` (reads `body.version`), which mirrors it onto the
      // `ETag` response header.
      version: entity.version,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      isNew,
      // Read through the ONE derivation, so `open`, `GET :id`, the list and
      // `GET :id/workflow` cannot disagree about a run's status — and so a malformed marker
      // reads as "the default loop governs" here exactly as it does at the substrate gate.
      governingRun: governingRunOf(entity.metadata),
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
