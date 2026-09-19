/**
 * Adding a `code` string with a custom status code for every
 * exception is a good practice, since when that exception
 * is transferred to another process `instanceof` check
 * cannot be performed anymore so a `code` string is used instead.
 * code constants can be stored in a separate file so they
 * can be shared and reused on a receiving side (code sharing is
 * useful when developing fullstack apps or microservices)
 */
export const ARGUMENT_INVALID = 'GENERIC.ARGUMENT_INVALID';
export const ARGUMENT_OUT_OF_RANGE = 'GENERIC.ARGUMENT_OUT_OF_RANGE';
export const ARGUMENT_NOT_PROVIDED = 'GENERIC.ARGUMENT_NOT_PROVIDED';
export const NOT_FOUND = 'GENERIC.NOT_FOUND';
export const CONFLICT = 'GENERIC.CONFLICT';
export const INTERNAL_SERVER_ERROR = 'GENERIC.INTERNAL_SERVER_ERROR';
export const UNAUTHORIZED = 'UNAUTHORIZED';

/** Domain layer */
export const BUSINESS = 'DOMAIN.BUSINESS';
// TASK-992 — an aggregate's state machine refused a transition because of the
// status the row is currently in. The API gateway maps this to 409 Conflict.
// Distinct from BUSINESS on purpose: a machine caller (the STT worker) must be
// able to recognise a state-machine refusal, and read `metadata.terminal`,
// without substring-matching the message — which is how a recoverable
// PROCESSING came to be classified as terminal and orphaned the job.
export const INVALID_STATE_TRANSITION = 'DOMAIN.INVALID_STATE_TRANSITION';
// A plan-entitlement quantity/meter limit was reached. The API gateway maps
// this to 409 Conflict (create) / 429 (meter).
export const QUOTA_EXCEEDED = 'DOMAIN.QUOTA_EXCEEDED';
// The tenant's optional monthly spend limit was reached. The
// API gateway maps this to 402 Payment Required.
export const SPEND_LIMIT_EXCEEDED = 'DOMAIN.SPEND_LIMIT_EXCEEDED';
// The tenant's OWN configuration forbids a provider: its
// connection row for that (service, provider) is disabled, which is a VETO of
// the platform-default credential, not merely "unused". The API gateway maps
// this to 409 Conflict — a tenant admin can clear it in the console, which is
// what distinguishes it from the 403 a missing entitlement produces.
export const PROVIDER_CREDENTIAL_VETOED = 'DOMAIN.PROVIDER_CREDENTIAL_VETOED';
// Consent & ABAC. `assertConsent` denied the call — no active
// grant, expired, revoked, or the grant's scope does not cover the request.
// The API gateway maps this to 403 (a privilege boundary), distinct from the
// 404-over-403 cross-tenant posture.
export const CONSENT_DENIED = 'DOMAIN.CONSENT_DENIED';
// Consent & ABAC. `assertConsent` could NOT determine a verdict
// (grant-store lookup failed — DB/connectivity error) and therefore denied
// fail-closed, same as CONSENT_DENIED — but for a DIFFERENT reason that
// needs a DIFFERENT reason code and DIFFERENT alerting: a genuine consent
// denial is an expected, un-alarming compliance event; an unavailability
// denial is an infrastructure incident wearing a compliance-shaped mask (R4,
// The API gateway
// maps this to 503, distinct from CONSENT_DENIED's 403.
export const CONSENT_UNAVAILABLE = 'DOMAIN.CONSENT_UNAVAILABLE';

/** Persistence layer */
export const DATA_CONFLICT = 'PERSISTENCE.DATA_CONFLICT';
export const DATABASE_CONNECTION_FAILED = 'PERSISTENCE.DATABASE_CONNECTION_FAILED';
export const DATA_CREATION_FAILED = 'PERSISTENCE.DATA_CREATION_FAILED';
export const QUERY_FAILED = 'PERSISTENCE.QUERY_FAILED';
export const DATA_NOT_FOUND = 'PERSISTENCE.DATA_NOT_FOUND';
export const TRANSACTION_FAILED = 'PERSISTENCE.TRANSACTION_FAILED';
export const CONCURRENCY_CONFLICT = 'PERSISTENCE.CONCURRENCY_CONFLICT';
