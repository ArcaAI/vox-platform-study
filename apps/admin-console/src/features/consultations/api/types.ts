import type { Paginated } from '@/shared/api';

/**
 * ConsultationStatus gateway enum (packages/domains) — GET /admin/consultations
 * validates `?status` against exactly these and 400s on anything else.
 */
export const CONSULTATION_STATUSES = ['OPEN', 'RECORDING', 'DRAFT_PENDING_SENSORS', 'PENDING_REVIEW', 'SIGNED', 'CLOSED', 'REOPENED'] as const;

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

/** Embedded doctor info (DoctorInfo on the gateway). */
export interface ConsultationDoctor {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

/** Embedded department info (DepartmentInfo on the gateway). */
export interface ConsultationDepartment {
  id: string;
  code?: string;
  name?: string;
}

/**
 * Related context item (ContextItemResponse subset) — only on the `GET :id`
 * detail. `type` is the ContextItemType enum (TRANSCRIPT, RAW_SUMMARY,
 * MODIFIED_SUMMARY, PRE_SUMMARY, WORKNOTE, CASE_NOTE, NAMED_ENTITY,
 * AUDIO_RECORDING, ATTACHMENT, SIGNED_NOTE); `source` is USER | AI | SYSTEM.
 */
export interface ConsultationContextItem {
  id: string;
  consultationId: string;
  type: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /admin/consultations rows and :id detail (ConsultationResponse). */
export interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  doctor?: ConsultationDoctor;
  departmentId?: string;
  department?: ConsultationDepartment;
  /** yyyy-MM-dd. */
  appointmentDate: string;
  /** Present on re-visits/referrals; absent on initial visits. */
  parentConsultationId?: string;
  /** ConsultationStatus enum value (legacy rows may carry metadata strings). */
  status?: string;
  metadata?: Record<string, unknown>;
  /** Only populated by the :id detail (findWithRelations includes them). */
  contextItems?: ConsultationContextItem[];
  createdAt: string;
  updatedAt: string;
}

/** { data, count, page, limit } — page echoes the 1-based request page. */
export type PaginatedConsultations = Paginated<Consultation>;

/**
 * GET /admin/consultations filters. NOTE: unlike the platform-wide 0-based
 * PaginatedQuery, this endpoint is 1-BASED — the controller coerces
 * `Number(page) || 1` and the repository skips `(page - 1) * limit`, so
 * page=0 silently behaves as page=1. There is NO server-side type
 * (new/revisit) param — that attribute is derived per row (visitTypeOf).
 */
export interface ListConsultationsParams {
  /** 1-based page (0 coerces to 1 server-side). */
  page?: number;
  limit?: number;
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
  status?: ConsultationStatus;
  /** Keeps the params assignable to QueryParams. */
  [key: string]: string | number | boolean | undefined | null;
}

/** GET aggregate — from/to are REQUIRED (400 without both). */
export interface ConsultationAggregateParams {
  /** Range start (ISO-8601 / yyyy-MM-dd). */
  from: string;
  /** Range end (ISO-8601 / yyyy-MM-dd). */
  to: string;
  /** Forced bucket size; omitted = day, or month for >70-day spans. */
  granularity?: 'day' | 'month';
  [key: string]: string | number | boolean | undefined | null;
}

/** One zero-filled date bucket (ConsultationAggregateBucket). */
export interface ConsultationAggregateBucket {
  /** Stable key: yyyy-MM-dd (day) or yyyy-MM (month). */
  key: string;
  /** Axis label: "MMM d" (day) or "MMM" (month). */
  label: string;
  /** Bucket start (ISO-8601, inclusive). */
  start: string;
  /** Bucket end (ISO-8601, inclusive). */
  end: string;
  /** Initial visits (parentConsultationId IS NULL). */
  newVisits: number;
  /** Follow-ups (parentConsultationId IS NOT NULL). */
  revisits: number;
  total: number;
}

/** GET aggregate response (ConsultationAggregateResponse). */
export interface ConsultationAggregate {
  buckets: ConsultationAggregateBucket[];
  totals: {
    total: number;
    newVisits: number;
    revisits: number;
  };
  granularity: 'day' | 'month';
  refreshedAt: string;
}

export const VISIT_TYPES = ['new', 'revisit'] as const;

export type ConsultationVisitType = (typeof VISIT_TYPES)[number];

/**
 * Row attribute mirroring the aggregate DTO semantics: no parent ⇒ initial
 * ("new") visit, parent present ⇒ revisit. The list API exposes no type
 * filter param, so any type filtering is client-side over the loaded page.
 */
export function visitTypeOf(consultation: Pick<Consultation, 'parentConsultationId'>): ConsultationVisitType {
  return consultation.parentConsultationId ? 'revisit' : 'new';
}
