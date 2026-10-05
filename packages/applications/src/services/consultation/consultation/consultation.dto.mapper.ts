import { ConsultationEntity, ContextItemEntity, UserEntity, DepartmentEntity } from '@arcaai/domains';
import { ConsultationResponse, DoctorInfo, DepartmentInfo } from './dto';
import { readSpokenLanguageMode } from './summary-language';
import { resolveVisitTypeKey } from './open-markers';
import { DEFAULT_VISIT_TYPE_SERVICE } from '../visit-type/visit-type.service';
import { governingRunOf } from '../governing-engine';
import { ContextDtoMapper } from '../context/context.dto.mapper';
import { EncounterDtoMapper, type EncounterLike } from '../encounter/encounter.dto.mapper';
import type { ConsultationLifecycleView } from '../encounter/lifecycle-view';

const VISIT_TYPE_KEYS: ReadonlySet<string> = new Set(['new-visit', 'revisit']);

/**
 * Consultation DTO Mapper
 *
 * Maps ConsultationEntity to response DTOs
 */
export class ConsultationDtoMapper {
  /**
   * Convert entity to response.
   *
   * `view` carries the episode facts that live outside the row (encounters, approval, auto-close
   * deadline, reopen policy) and is loaded for single-consultation answers. Without it — list
   * answers — the encounters come from an included `Encounters` relation when there is one (else
   * `[]`), `approval` and `autoCloseAt` are `null`, and a CLOSED_COMPLETE row reads as not
   * reopenable.
   */
  static toResponse(
    entity: ConsultationEntity,
    isNew = false,
    view?: ConsultationLifecycleView,
    extras?: { encounterAppended?: boolean },
  ): ConsultationResponse {
    // `Consultation.status` is the SOLE lifecycle tracker; `processing` is its background axis.
    const included = entity.Encounters as EncounterLike[] | null | undefined;
    const encounters = view?.encounters ?? (included ? EncounterDtoMapper.toResponses(included) : []);
    const current = encounters.find((encounter) => encounter.seq === entity.currentEncounterSeq);
    const response: ConsultationResponse = {
      id: entity.id,
      patientId: entity.patientId,
      doctorId: entity.doctorId,
      doctor: entity.Doctor ? this.mapDoctor(entity.Doctor) : undefined,
      departmentId: entity.departmentId ?? undefined,
      department: entity.Department ? this.mapDepartment(entity.Department) : undefined,
      appointmentDate: entity.appointmentDate.toISOString().split('T')[0],
      parentConsultationId: entity.parentConsultationId ?? undefined,
      status: entity.status,
      // Derived, never stored: audio can be captured into OPEN / RECORDING / PAUSED / STOPPED.
      recordable: entity.isRecordable,
      // The current encounter's visit type when it is in the vocabulary; otherwise the same
      // resolution every prompt/workflow reader uses.
      visitType:
        current && VISIT_TYPE_KEYS.has(current.visitType)
          ? (current.visitType as ConsultationResponse['visitType'])
          : resolveVisitTypeKey(DEFAULT_VISIT_TYPE_SERVICE, entity.tenantId, entity.metadata, entity.parentConsultationId),
      // The current encounter's id when the encounters are known; otherwise the row's own column.
      externalRef: current ? current.externalRef : (entity.externalRef ?? null),
      processing: entity.processing,
      processingReason: entity.processingReason ?? null,
      lastActivityAt: entity.lastActivityAt.toISOString(),
      autoCloseAt: view?.autoCloseAt ? view.autoCloseAt.toISOString() : null,
      reopenCount: entity.reopenCount,
      closedReason: entity.closedReason ?? null,
      closedAt: entity.closedAt ? entity.closedAt.toISOString() : null,
      reopenAllowed: entity.reopenAllowed(view?.allowClosedCompleteReopen ?? false),
      currentEncounterSeq: entity.currentEncounterSeq,
      encounters,
      approval: view?.approval ?? null,
      lifecycle: { status: entity.status, processing: entity.processing },
      // TASK-932 §3.7 / TASK-1004 D-3 — read through the ONE reader: the typed
      // `spokenLanguageMode` column first, the legacy `metadata.summaryLanguage` marker for one
      // release after it, so every surface reports the same declaration.
      language: readSpokenLanguageMode(entity) ?? undefined,
      metadata: entity.metadata as Record<string, unknown> | undefined,
      // the OCC row version, so a client can build the `If-Match`
      // header the lifecycle routes require. Also feeds
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
    if (extras?.encounterAppended !== undefined) {
      response.encounterAppended = extras.encounterAppended;
    }
    return response;
  }

  /**
   * Convert entity to response with context items
   */
  static toResponseWithContext(entity: ConsultationEntity, isNew = false, view?: ConsultationLifecycleView): ConsultationResponse {
    const response = this.toResponse(entity, isNew, view);

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
