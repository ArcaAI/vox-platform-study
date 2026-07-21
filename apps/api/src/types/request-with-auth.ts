import type { Request } from 'express';
import type { ApiKeyEntity } from '@arcaai/domains';
import type { UserSession } from '@arcaai/applications';

/**
 * Narrowed Express `Request` for handlers that touch the authentication
 * pipeline.
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
 * Reaching these fields via `request['apiKey']` (string-key) or an inline
 * anonymous type would silently accept typos: `request['aip_key']`
 * evaluates to `undefined`, which skips the authentication check and
 * silently authorises the request.
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
