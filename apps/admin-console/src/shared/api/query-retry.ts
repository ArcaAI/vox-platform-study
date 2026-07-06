import { GatewayError } from './http';

/**
 * App-wide TanStack Query retry policy (TASK-428): one retry for transient
 * failures (network errors, gateway 5xx), none for 4xx — a client error is
 * deterministic, so a retry just replays the same failure and doubles the
 * request count. 401 is covered by the BFF proxy's own single-flight
 * refresh+retry, so it is not retried here either.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
    if (failureCount >= 1) return false;
    if (error instanceof GatewayError && error.status >= 400 && error.status < 500) return false;
    return true;
}
