import type { Request } from 'express';
import type { ApiKeyEntity } from '@arcaai/domains';
import type { UserSession } from '@arcaai/applications';

/**
 * TASK-310 E-6 (AC-6) — narrowed Express `Request` for handlers that
 * touch the authentication pipeline.
 *
 * The auth chain (`UnifiedAuthGuard` in `@arcaai/applications` /
 * `JwtAuthGuard` in `apps/api/src/guards`) populates three fields on
 * the live Express request:
 *   - `apiKey`    set by `UnifiedAuthGuard` after a successful
 *                 `extractApiKeyFromRequest` + `authenticateByRawKey`.
 *   - `user`      set by the Passport JWT strategy (or by
 *                 `JwtAuthGuard.handleTicketAuth` for stream tickets).
 *   - `tenantId`  reserved for handlers that need a request-scoped
 *                 tenant override; the canonical tenant lookup is the
 *                 CLS context, not this field.
 *
 * Pre-W7.A.14, downstream code reached these via `request['apiKey']`
 * (string-key) or via inline anonymous types. Both patterns silently
 * accept typos: `request['aip_key']` evaluates to `undefined`, which
 * skips the authentication check and silently authorises the request.
 *
 * Using `RequestWithAuth` as the parameter type forces TypeScript to
 * reject those typos at compile-time. All three auth-pipeline fields
 * stay `undefined`-able because public / pre-auth routes (`@Public`
 * decorators) reach the handler without any of them set.
 */
export interface RequestWithAuth extends Request {
  apiKey?: ApiKeyEntity;
  user?: UserSession;
  tenantId?: string;
}
