import { SetMetadata } from '@nestjs/common';

/**
 * Reflector key for the `@RequiresIfMatch()` route-level marker.
 *
 * Exported so the companion guard (`RequiresIfMatchGuard`) and any future
 * Swagger plugin can read the metadata.
 */
export const REQUIRES_IF_MATCH_KEY = 'requiresIfMatch';

/**
 * Marks a mutating route as requiring the RFC 7232 `If-Match` header.
 * On a request that omits the header, the response is `428 Precondition
 * Required` (RFC 6585) — distinct from a generic 400, so SDKs can branch
 * on the status to surface the right UX ("please update your SDK") vs.
 * the 412 conflict UX ("refresh and try again").
 *
 * The decorator is metadata-only (`SetMetadata`); the runtime work happens
 * in the global `RequiresIfMatchGuard`, which flips
 * `req._requiresIfMatch = true` so the downstream `@ExpectedVersion()`
 * parameter decorator knows whether a missing header is fatal.
 *
 * Pair with `@ExpectedVersion()` on a handler parameter to receive the
 * parsed number.  Service-to-service callers may continue to pass the
 * `expectedVersion` field in the request body when no header is present
 * — this is the documented fallback.
 *
 * ## Usage
 *
 *     @Patch('me/config')
 *     @RequiresIfMatch()
 *     async updateMyConfig(
 *       @Body() configs: UpdateTenantConfigRequest[],
 *       @ExpectedVersion() expected: number,
 *     ) { ... }
 *
 * ## Rules
 *  - ONLY apply to MUTATING routes (PATCH, PUT, DELETE). Never on GET.
 *  - The route handler must also annotate Swagger with `@ApiResponse({ status: 412 })`
 *    and `@ApiResponse({ status: 428 })` so clients see the contract in
 *    the API docs.
 *
 * @see apps/api/src/decorators/expectedVersion.decorator.ts
 * @see apps/api/src/decorators/requiresIfMatch.guard.ts
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
 * @see https://www.rfc-editor.org/rfc/rfc6585.html
 */
export const RequiresIfMatch = (): MethodDecorator => SetMetadata(REQUIRES_IF_MATCH_KEY, true);
