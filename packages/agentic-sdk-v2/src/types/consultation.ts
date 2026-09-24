/**
 * @arcaai/vox - Consultation Types
 *
 * Types for consultation/session management.
 */

import type { GoverningRunSummary } from '@arcaai/types';
import type { ContextItem, AddContextInput } from './context';
import type { LanguageModeId } from './language';

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
  /**
   * The consultation's SOURCE language as declared at open — what is spoken, including an STT
   * code-switch mode such as `ml-en`. Set it with {@link OpenSessionInput.language}.
   *
   * It does NOT choose the note's language (HOPE TASK-1001, owner decision 2026-09-23): notes are
   * written in the tenant's configured output language, else the platform default (English).
   */
  language?: string;
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
  /**
   * The consultation's governing workflow run, derived server-side from the persisted
   * `metadata.governingEngine` marker — never a live harness call. `null`/`undefined` when the
   * consultation is ungoverned or the server has not yet populated the field (older gateway
   * builds). See `useConsultationWorkflow` for the same fact read a second way, and
   * `GoverningRunSummary` (`@arcaai/types`) for the shape.
   */
  governingRun?: GoverningRunSummary | null;
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
   * lane (`useArcaSessionManager`) keeps compiling; see notes.
   */
  department?: string;
  /**
   * pick the tenant-authored workflow that GOVERNS this
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
  /**
   * The consultation's SOURCE language as declared at open — what is SPOKEN, as a BCP-47 tag
   * (`en`, `ml`, `en-IN`) or an STT code-switch mode such as `ml-en` ("Malayalam-led, English
   * mixed").
   *
   * **Corrected TASK-1004 (G-7): this is NOT the note's language**, and the difference is the
   * point of the field: a Malayalam-English consultation is routinely documented in English. The
   * pre-summary, live summary and final summary are written in the tenant's configured output
   * language, or the platform default (English) when the tenant has none — never in the language
   * declared here (TASK-1001 OD-12). Prefer {@link languageMode} — a normalized catalog id
   * rather than a free-form tag — when you have one; sending both is fine, and `languageMode`
   * wins.
   *
   * Every live/batch STT entry point this consultation's recordings reach
   * (`audio.start({ languageMode })`, batch transcription) inherits this value when it declares
   * no mode of its own — declare it here once rather than on every session.
   *
   * Honoured by `session.open()` and by a re-visit. Re-opening an ALREADY-OPEN consultation keeps
   * the language it was opened with, the same way it keeps its governing workflow. Read it back
   * on {@link Consultation.language}. Changing it after open (e.g. `PATCH consultations/:id`,
   * OCC) is not yet exposed as a hook on this SDK — see `@arcaai/vox-node`'s
   * `consultations.updateLanguage()` for the server-side equivalent.
   */
  language?: string;
  /**
   * The same SOURCE language as {@link language}, as a catalog mode id (e.g. `'ml-en'`) rather
   * than a BCP-47 tag. TASK-1004: preferred over {@link language} — when both are sent this one
   * wins; the gateway normalizes either into the same stored mode.
   */
  languageMode?: LanguageModeId;
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
