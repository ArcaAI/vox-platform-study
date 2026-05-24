import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_IF_MATCH_KEY } from './requiresIfMatch.decorator';

/**
 * Companion guard for `@RequiresIfMatch()` — TASK-302 Stream D Phase D
 * (D.2).
 *
 * Runs globally, but only has work to do on routes annotated with
 * `@RequiresIfMatch()`. When annotated, it sets
 * `req._requiresIfMatch = true` so the `@ExpectedVersion()` parameter
 * decorator can throw `428 Precondition Required` on a missing
 * `If-Match` header.
 *
 * ## Why split decorator/guard from the param extractor?
 * - The decorator stays trivially-composable on controller methods.
 * - 428 logic lives where the header is actually parsed (in
 *   `extractExpectedVersion`), keeping the error site close to the cause.
 * - Non-annotated routes pay zero cost: a single `Reflector.getAllAndOverride`
 *   read, no throw, no body parsing.
 *
 * ## Why return `true` unconditionally?
 * A guard that returned `false` would short-circuit with a 403 Forbidden
 * before the param decorator ever ran, masking the real 428 contract.
 * This guard ONLY annotates the request; the throwing happens later.
 *
 * @see apps/api/src/decorators/requiresIfMatch.decorator.ts
 * @see apps/api/src/decorators/expectedVersion.decorator.ts
 */
@Injectable()
export class RequiresIfMatchGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const annotated = this.reflector.getAllAndOverride<boolean>(REQUIRES_IF_MATCH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (annotated) {
      const req = context.switchToHttp().getRequest<{ _requiresIfMatch?: boolean }>();
      req._requiresIfMatch = true;
    }
    return true;
  }
}
