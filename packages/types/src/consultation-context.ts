/**
 * The consultation-context contract shared by the gateway, both SDKs, and codegen.
 *
 * `OPEN_REFUSAL_CODES` names every refusal `POST consultations/open` can answer with a 4xx
 * `{ message, code, problems? }` body, and `GoverningRunSummary` is the persisted-vocabulary view
 * of a consultation's governing workflow run, derived from `Consultation.metadata.governingEngine`
 * by `governingRunOf` (`packages/applications/src/services/consultation/governing-engine.ts`).
 */

/** Every refusal `POST consultations/open` can answer with a 4xx `{ message, code, problems? }` body. */
export const OPEN_REFUSAL_CODES = [
  'CONTEXT_SCHEMA_VIOLATION',
  'DEPARTMENT_UNKNOWN',
  'DEPARTMENT_AMBIGUOUS',
  'DEPARTMENT_MISMATCH',
  'VISIT_TYPE_INVALID',
  'CLINICIAN_REQUIRED',
  'CLINICIAN_MISMATCH',
  'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER',
  'USER_IDENTITY_UNKNOWN',
  'USER_IDENTITY_AMBIGUOUS',
  'USER_IDENTITY_INVALID',
  'USER_IDENTITY_NOT_USABLE',
  'USER_IDENTITY_DEPARTMENT_UNRESOLVED',
  'WORKFLOW_CONTEXT_INCOMPATIBLE',
] as const;

export type OpenRefusalCode = (typeof OPEN_REFUSAL_CODES)[number];

/** The governing run of a consultation, derived from `Consultation.metadata.governingEngine`. */
export interface GoverningRunSummary {
  workflowDefinitionSlug: string;
  workflowRunId: string;
  /** Persisted vocabulary only — never the interpreter's `SUCCEEDED`/`DEGRADED`. */
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';
  /** True when the run finished with at least one degraded or skipped-for-cause node. */
  degraded: boolean;
  decidedAt: string;
  failureReason: string | null;
}
