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
// TASK-392 (Q10) — a plan-entitlement quantity/meter limit was reached. The API
// gateway maps this to 409 Conflict (create) / 429 (meter) in Phase 4.
export const QUOTA_EXCEEDED = 'DOMAIN.QUOTA_EXCEEDED';

/** Persistence layer */
export const DATA_CONFLICT = 'PERSISTENCE.DATA_CONFLICT';
export const DATABASE_CONNECTION_FAILED = 'PERSISTENCE.DATABASE_CONNECTION_FAILED';
export const DATA_CREATION_FAILED = 'PERSISTENCE.DATA_CREATION_FAILED';
export const QUERY_FAILED = 'PERSISTENCE.QUERY_FAILED';
export const DATA_NOT_FOUND = 'PERSISTENCE.DATA_NOT_FOUND';
export const TRANSACTION_FAILED = 'PERSISTENCE.TRANSACTION_FAILED';
export const CONCURRENCY_CONFLICT = 'PERSISTENCE.CONCURRENCY_CONFLICT';
