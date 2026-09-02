/**
 * @arcaai/vox - Consultation Types
 *
 * Types for consultation/session management.
 */

import type { ContextItem, AddContextInput } from './context';

// =============================================================================
// Consultation Status (SES-02)
// =============================================================================

/**
 * Consultation lifecycle status.
 *
 * Extended lifecycle statuses track where a consultation is in the
 * recording → transcription → summarization pipeline. The backend may
 * still return the legacy values ('active', 'completed', 'cancelled')
 * which map to OPEN, CLOSED, and CANCELLED respectively.
 */
export type ConsultationStatus =
  'OPEN' | 'RECORDING' | 'TRANSCRIBING' | 'SUMMARIZING' | 'REVIEW' | 'CLOSED' | 'CANCELLED' | 'active' | 'completed' | 'cancelled';

/**
 * Ordered lifecycle phases for progress display.
 * Does not include terminal states (CLOSED, CANCELLED) or legacy values.
 */
export const CONSULTATION_STATUS_ORDER: readonly ConsultationStatus[] = ['OPEN', 'RECORDING', 'TRANSCRIBING', 'SUMMARIZING', 'REVIEW'] as const;

/** Map legacy backend values to canonical status. */
export function normalizeConsultationStatus(status: ConsultationStatus): ConsultationStatus {
  switch (status) {
    case 'active':
      return 'OPEN';
    case 'completed':
      return 'CLOSED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return status;
  }
}

// =============================================================================
// Consultation Types
// =============================================================================

/**
 * Consultation entity
 *
 * Uses natural key: (patientId, doctorId, appointmentDate)
 */
export interface Consultation {
  /** Unique consultation ID */
  id: string;
  /** Patient identifier */
  patientId: string;
  /** Doctor identifier */
  doctorId: string;
  /** Doctor display name */
  doctorName?: string;
  /** Appointment date (YYYY-MM-DD format) */
  appointmentDate: string;
  /** Department/specialty */
  department?: string;
  /** Lifecycle status. Optional for backward-compat — absent when backend hasn't adopted the extended enum. */
  status?: ConsultationStatus;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Context items (when loaded) */
  contextItems?: ContextItem[];
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Whether this consultation was just created (from getOrCreate) */
  isNew?: boolean;
  /**
   * Row `_version` — the RFC 7232 strong validator the gateway renders as
   * `ETag: "<version>"`.
   *
   * `PATCH /consultations/:id` requires `If-Match`, so the SDK echoes this
   * value back on the next write (`useArcaSession.update` /
   * `useArca.updateConsultation`). Optional because older gateway builds and
   * projections omit it; when it is absent the SDK sends NO precondition
   * rather than inventing one.
   */
  version?: number;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Open Session Input - Input for opening a consultation
 *
 * Note: doctorId comes from authenticated user, not from input
 */
export interface OpenSessionInput {
  /** Patient identifier */
  patientId: string;
  /** Appointment date (YYYY-MM-DD). Defaults to today if not provided. */
  appointmentDate?: string;
  /**
   * Department id (a `Department` row id), forwarded verbatim to
   * `POST /consultations/open`.
   *
   * This is the field that makes department-scoped SOAP autofill reachable:
   * `SummaryService` resolves the department prompt tier from
   * `consultation.departmentId`, and `ConsultationWorkflowDispatchService`
   * resolves the workflow-assignment cascade's department tier from the same
   * column. Omit it and both silently fall through to the tenant tier.
   */
  departmentId?: string;
  /**
   * @deprecated Not accepted by the gateway. `OpenConsultationRequest`
   * declares no `department` field and the global validation pipe runs
   * `forbidNonWhitelisted`, so sending this REJECTS the open with HTTP 400.
   * Use {@link OpenSessionInput.departmentId}. Retained only so the v1-compat
   * lane (`useArcaSessionManager`) keeps compiling; see TASK-793 notes.
   */
  department?: string;
  /**
   * TASK-813 OD-1 — pick the tenant-authored workflow that GOVERNS this
   * consultation, overriding the `department → tenant → platform-default`
   * assignment cascade.
   *
   * Must be one of your own tenant's published, active `consultation`-palette
   * definition slugs (`[a-z0-9_]{2,48}`). The gateway authorizes it BEFORE the
   * consultation is written: a slug your tenant cannot see is a 404 (never a
   * 403 — that would confirm it exists), and one it can see but which cannot
   * govern a consultation is a 403.
   *
   * Omit it and the cascade decides, which is the default and unchanged
   * behaviour. Honoured by `session.open()` only — a re-visit dispatches no
   * consultation workflow, so there is nothing there to steer.
   *
   * Read back what actually governs with {@link useConsultationWorkflow}:
   * dispatch is best-effort by design, so a harness outage degrades to the
   * platform default engine rather than failing the open.
   */
  workflowDefinitionSlug?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Create Consultation Input (SES-02)
 *
 * Input for explicitly creating a new consultation.
 * Unlike OpenSessionInput (get-or-create), this always creates.
 */
export interface CreateConsultationInput {
  /** Patient identifier */
  patientId: string;
  /** Appointment date (YYYY-MM-DD) */
  appointmentDate: string;
  /** Department/specialty */
  department?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Start Revisit Input (SES-02)
 *
 * Input for creating a follow-up consultation linked to a parent.
 */
export interface StartRevisitInput {
  /** ID of the parent consultation to revisit */
  parentConsultationId: string;
  /** Appointment date (YYYY-MM-DD). Defaults to today if not provided. */
  appointmentDate?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Update Consultation Input (SES-02)
 *
 * Partial update fields for an existing consultation.
 */
export interface UpdateConsultationInput {
  /** Update department/specialty */
  department?: string;
  /** Update status */
  status?: ConsultationStatus;
  /** Update metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Timeline Types (SES-04)
// =============================================================================

/**
 * Scope for timeline queries.
 * - 'single': events from this consultation only
 * - 'chain': events from the entire consultation chain (parent + revisits)
 */
export type TimelineScope = 'single' | 'chain';

/**
 * A single entry in the consultation timeline.
 *
 * Represents an event that occurred during the consultation lifecycle
 * (e.g., context added, summary generated, NER extracted).
 */
export interface TimelineEntry {
  /** Unique entry ID */
  id: string;
  /** Consultation this entry belongs to */
  consultationId: string;
  /** Event type */
  type: string;
  /** When the event occurred */
  timestamp: string;
  /** Human-readable description */
  description: string;
  /** Optional structured metadata for the event */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Session State & Actions
// =============================================================================

/**
 * Session State - State for useArcaSession hook
 */
export interface SessionState {
  /** Current consultation (null if none open) */
  consultation: Consultation | null;
  /** Context items for current consultation */
  context: ContextItem[];
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Session Actions - Actions interface
 */
export interface SessionActions {
  /** Open a consultation session (get-or-create) */
  open: (input: OpenSessionInput) => Promise<Consultation>;
  /** Add context to current consultation */
  addContext: (input: AddContextInput) => Promise<ContextItem>;
  /** Get shared context from all doctors on same date */
  getSharedContext: () => Promise<ContextItem[]>;
  /** Get patient consultation history */
  getPatientHistory: (patientId: string) => Promise<Consultation[]>;
  /** Load a specific consultation (for viewing history) */
  loadConsultation: (consultationId: string) => Promise<Consultation>;
  /** Update the current consultation (department/status/metadata) (SES-02) */
  update: (input: UpdateConsultationInput) => Promise<Consultation>;
  /**
   * Prime the current consultation — the session state machine's first
   * checkpoint, which the gateway also uses as the AI_DOCUMENTATION consent
   * checkpoint. Optimistically concurrent (`If-Match`), like close/reopen.
   */
  prime: () => Promise<Consultation>;
  /** Close the current consultation (sets status to CLOSED) */
  close: () => Promise<Consultation>;
  /** Reopen a previously closed consultation (sets status to OPEN) */
  reopen: () => Promise<Consultation>;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a consultation is a new visit (just created).
 */
export function isNewVisit(consultation: Consultation | null): boolean {
  return consultation?.isNew === true;
}

/**
 * Check if a consultation is a revisit (has parent chain).
 * Revisits have metadata indicating a parent consultation.
 */
export function isRevisit(consultation: Consultation | null): boolean {
  if (!consultation) return false;
  return !!consultation.metadata?.parentConsultationId;
}

// Re-export AddContextInput from context.ts for convenience
export type { AddContextInput } from './context';
