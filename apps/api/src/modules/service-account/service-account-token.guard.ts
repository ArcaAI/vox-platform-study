import { BadRequestException, CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';

/**
 * The dedicated guard on `POST /api/v1/auth/service-token` (TASK-762 §5.7 F).
 *
 * The route is `@Public()` because it is the route that ESTABLISHES a
 * credential — there is nothing for `UnifiedAuthGuard` to authenticate. Public
 * must never mean UNGUARDED, which is the same invariant the `/internal/*`
 * audit already enforces, so this guard stands in its place.
 *
 * What it enforces is SHAPE, before any credential comparison runs:
 *
 *  - a `clientId` and a `clientSecret` are present and are strings of plausible
 *    length, so a malformed body is rejected without ever reaching the
 *    constant-time verifier path (and without burning a DB read);
 *  - no credential arrives in the QUERY STRING or a header. Accepting a secret
 *    anywhere but the body would put it in access logs, browser history and
 *    proxy traces — see the privacy rule against credentials in URLs.
 *
 * It deliberately does NOT verify the credential: that is
 * `ServiceAccountService.exchangeToken`'s job, where the comparison is
 * constant-time and the denial is non-enumerable.
 */
@Injectable()
export class ServiceAccountTokenGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAccountTokenGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const query = (request?.query ?? {}) as Record<string, unknown>;
    if (query.clientSecret !== undefined || query.client_secret !== undefined || query.clientId !== undefined) {
      this.logger.warn({ message: 'service_account.exchange_rejected', reason: 'credential_in_query_string' });
      throw new BadRequestException('Service-account credentials must be sent in the request body, never in the query string');
    }

    const body = (request?.body ?? {}) as Record<string, unknown>;
    const clientId = body.clientId;
    const clientSecret = body.clientSecret;

    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw new BadRequestException('clientId is required');
    }
    if (typeof clientSecret !== 'string' || clientSecret.length < 32) {
      // Length-only shape check. It reveals nothing about any real credential:
      // every issued secret is 64 hex chars, so this rejects only malformed
      // requests, never a wrong-but-plausible one (which must reach the
      // non-enumerable 401 instead).
      throw new BadRequestException('clientSecret is required');
    }

    return true;
  }
}
