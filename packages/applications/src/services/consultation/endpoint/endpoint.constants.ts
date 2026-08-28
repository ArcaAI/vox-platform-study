/**
 * TASK-812 — endpoint-stage constants shared by the service, its DTOs and the internal route.
 *
 * Deliberately a tiny module of its own rather than exports on the service: the harness speaks
 * these strings on the wire (`ENDPOINT_REASON_*` mirrors `apps/harness/.../temporal/models.py`),
 * and a wire vocabulary that lives inside a service class is one an importer has to construct a
 * service to read.
 */

/**
 * How a consultation session reached its endpoint.
 *
 * `TIMED_OUT` is the D-12 case and the reason this vocabulary exists at all. Before TASK-812 an
 * expiry ABANDONED the run, so there was nothing to record and no way to tell a note produced
 * from a complete consultation from one produced from a truncated recording. Now expiry runs the
 * endpoint sequence — which makes stamping the distinction mandatory, not optional: a clinician
 * reviewing the note is entitled to know the transcript may stop mid-encounter.
 */
export const ENDPOINT_REASON_ENDED = 'ENDED';
export const ENDPOINT_REASON_TIMED_OUT = 'TIMED_OUT';
export const ENDPOINT_REASON_CANCELLED = 'CANCELLED';

export const ENDPOINT_REASONS = [ENDPOINT_REASON_ENDED, ENDPOINT_REASON_TIMED_OUT, ENDPOINT_REASON_CANCELLED] as const;

export type EndpointReason = (typeof ENDPOINT_REASONS)[number];

/**
 * `Consultation.metadata` key holding the endpoint disposition block.
 *
 * `metadata` (the tenant-facing JSONB, not `_metadata`) is the same column the legacy
 * `metadata.status` lived in before it was promoted to a typed column, so this is the
 * established home for a per-consultation fact that has no query surface of its own. It is also
 * why the write is a converging UPSERT of ONE key: a retried activity rewrites the same block.
 */
export const CONSULTATION_ENDPOINT_METADATA_KEY = 'endpoint';

/**
 * `ContextItemVersion.changeReason` for a promoted advisory correction.
 *
 * The column's own comment already names `"correction"` as one of its values; this is the
 * constant that makes the platform actually use it, and it is queryable
 * (`getVersionsByChangeReason`) precisely because it is not encrypted — which is what the
 * idempotency check below depends on.
 */
export const CORRECTION_CHANGE_REASON = 'correction';

/**
 * `ContextItemVersion.changeSource` prefix for a promotion, completed by a deterministic digest
 * of the accepted proposal ids.
 *
 * DD-8 in one string. `changeSource` says WHERE a change to clinical text came from, and every
 * promoted correction says `feedback.capture:<digest>` — so "which path promoted this?" is
 * answerable from the row, and "has this exact set of acceptances already been promoted?" is
 * answerable without decrypting anything. The digest is what makes a Temporal retry converge
 * instead of writing a second identical version.
 */
export const CORRECTION_CHANGE_SOURCE_PREFIX = 'feedback.capture';
