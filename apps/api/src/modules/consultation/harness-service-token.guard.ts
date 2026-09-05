import { SecretsService } from '@arcaai/applications';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * HarnessServiceTokenGuard.
 *
 * Service-to-service auth for the `/internal/harness/*` endpoints. The harness
 * presents `X-Service-Token`, which must match EITHER the shared
 * `INTERNAL_ACCESS_TOKEN` or the legacy per-service `HARNESS_SERVICE_TOKEN`
 * (both resolved via SecretsService).
 *
 * WHY BOTH, and in that order (TASK-869). The harness has already migrated to
 * the one-shared-token model: `HarnessSettings.peer_service_token` presents
 * `INTERNAL_ACCESS_TOKEN` first and only falls back to the legacy per-service
 * value, and its own inbound guard accepts either via `accepted_service_tokens`.
 * This guard accepted the legacy token ALONE, so every worker callback
 * (`/progress`, `/draft`, …) 401'd, the durable workflow failed, and the job sat
 * at PENDING — which surfaced as "the harness lane needs an env flag" rather
 * than as an auth mismatch. Accepting both makes the two sides symmetric and
 * matches the owner directive that one devops-set token serves every internal
 * call, while leaving the legacy credential working for anything not yet moved.
 *
 * Fail-closed: a missing header, NEITHER secret configured, or a mismatch
 * against both all reject. Comparison is constant-time; every candidate is
 * compared (no early exit) so a valid-token answer cannot be told from an
 * invalid one by timing.
 */
@Injectable()
export class HarnessServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(HarnessServiceTokenGuard.name);

  constructor(@Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const headerValue = request.headers['x-service-token'];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!provided) {
      throw new UnauthorizedException('Internal harness endpoints require an X-Service-Token header');
    }

    const candidates = (
      await Promise.all([
        this.secretsService?.getSecretOptional('INTERNAL_ACCESS_TOKEN'),
        this.secretsService?.getSecretOptional('HARNESS_SERVICE_TOKEN'),
      ])
    ).filter((secret): secret is string => Boolean(secret));

    if (candidates.length === 0) {
      this.logger.error('Neither INTERNAL_ACCESS_TOKEN nor HARNESS_SERVICE_TOKEN is configured — rejecting internal harness request (fail-closed)');
      throw new UnauthorizedException('Internal harness authentication is not configured');
    }

    // `reduce`, not `some`: every candidate is compared even after a match, so
    // the number of comparisons does not depend on WHICH token was presented.
    const matched = candidates.reduce((acc, candidate) => this.safeEqual(provided, candidate) || acc, false);
    if (!matched) {
      throw new UnauthorizedException('Invalid X-Service-Token');
    }

    return true;
  }

  /** Constant-time string comparison that short-circuits safely on length mismatch. */
  private safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  }
}
