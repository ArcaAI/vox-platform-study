import { SecretsService } from '@arcaai/applications';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * ServiceReleaseTokenGuard.
 *
 * `/internal/service-releases*` is a shared registration surface: every one
 * of the ~15 self-registering processes (six Python services, the gateway
 * itself — in-process, no HTTP call — admin-console, and the two workers)
 * calls it. There is no single owning service the way `HarnessServiceTokenGuard`
 * has one, so the presented `X-Service-Token` is accepted when it matches ANY
 * currently-configured per-service secret (same secret names
 * `InternalServiceTokenGuard` resolves), rather than requiring a `?service=`
 * selector up front — the caller's identity here is carried in the request
 * BODY (`service`), not the query string, and guards run before body
 * validation.
 *
 * Fail-closed: a missing header, no configured secrets at all, or a mismatch
 * against every configured secret all reject with 401. Comparison is
 * constant-time so the token cannot be recovered by timing.
 */
@Injectable()
export class ServiceReleaseTokenGuard implements CanActivate {
  private readonly logger = new Logger(ServiceReleaseTokenGuard.name);

  /**
   * Secret names this guard will accept a match against — mirrors `InternalServiceTokenGuard`.
   *
   * `INTERNAL_ACCESS_TOKEN` leads the list: it is the ONE shared credential every
   * migrated service self-registers with (owner decision D-D). It was MISSING
   * when `TTS_SERVICE_TOKEN` was struck from this list in TASK-879/880, which
   * left a migrated TTS process able to register only when some other service's
   * legacy secret happened to hold the same value; `text` joined the shared token
   * in TASK-888 and would have hit the same wall.
   */
  private static readonly KNOWN_SECRETS: readonly string[] = [
    'INTERNAL_ACCESS_TOKEN',
    'NLP_SERVICE_TOKEN',
    'GUARDRAIL_SERVICE_TOKEN',
    'HARNESS_SERVICE_TOKEN',
    'API_GATEWAY_KEY',
  ];

  constructor(@Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const headerValue = request.headers['x-service-token'];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!provided) {
      throw new UnauthorizedException('Internal service-release endpoints require an X-Service-Token header');
    }

    if (!this.secretsService) {
      this.logger.error('SecretsService unavailable — rejecting internal service-release request (fail-closed)');
      throw new UnauthorizedException('Internal service authentication is not configured');
    }

    for (const secretName of ServiceReleaseTokenGuard.KNOWN_SECRETS) {
      const expected = await this.secretsService.getSecretOptional(secretName);
      if (expected && safeEqual(provided, expected)) {
        return true;
      }
    }

    throw new UnauthorizedException('Invalid X-Service-Token');
  }
}

/** Constant-time comparison that short-circuits safely on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
