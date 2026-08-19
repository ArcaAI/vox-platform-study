/**
 * Barrel for `@arcaai/vox-node`'s transport core: URL joining, the typed
 * error hierarchy, PHI/secret redaction, retry policy, the `fetch` wrapper,
 * the SSE parser, and idempotency-key generation. Resources (`src/resources/**`)
 * and `src/client.ts` are the intended consumers of this module.
 */

export type { BuildUrlOptions, QueryValue } from './url';
export { buildUrl, encodePathSegment } from './url';

export type { APIConnectionErrorInit, FromResponseExtra, HopeAPIErrorInit, RateLimitErrorInit, VersionConflictErrorInit } from './errors';
export {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  HopeAPIError,
  HopeStreamError,
  NotFoundError,
  PermissionError,
  PreconditionRequiredError,
  QuotaExceededError,
  RateLimitError,
  VersionConflictError,
  fromResponse,
  parseRetryAfterMs,
} from './errors';

export { NODE_INSPECT_CUSTOM, RedactedValue, redact, redactHeaders } from './redact';

export type { ServiceAccountCredentials, ServiceAccountTokenExchangeResponse, ServiceAccountTokenProviderOptions } from './service-account-token';
export { SERVICE_ACCOUNT_TOKEN_HEADER, SERVICE_ACCOUNT_TOKEN_PATH, ServiceAccountTokenProvider } from './service-account-token';

export type { BackoffOptions, ExecuteWithRetryOptions, ShouldRetryInput } from './retry';
export { computeBackoffDelayMs, executeWithRetry, shouldRetry } from './retry';

export type { TransportConfig, TransportRequestOptions } from './transport';
export { Transport } from './transport';

export type { ParseSseStreamOptions, SseFrame } from './sse';
export { parseSseStream } from './sse';

export type { GenerateUuidV7Options } from './idempotency';
export { generateUuidV7 } from './idempotency';
