import { SecretsService } from '@arcaai/applications';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * HarnessServiceTokenGuard.
 *
 * Service-to-service auth for the `/internal/harness/*` endpoints. The harness
 * presents `X-Service-Token`, which must match the `HARNESS_SERVICE_TOKEN`
 * secret (resolved via SecretsService — same pattern as `SMR_SERVICE_TOKEN`).
 *
 * Fail-closed: a missing header, an unconfigured secret, or a mismatch all
 * reject. The comparison is constant-time to avoid leaking the token by timing.
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

    const expected = await this.secretsService?.getSecretOptional('HARNESS_SERVICE_TOKEN');
    if (!expected) {
      this.logger.error('HARNESS_SERVICE_TOKEN is not configured — rejecting internal harness request (fail-closed)');
      throw new UnauthorizedException('Internal harness authentication is not configured');
    }

    if (!this.safeEqual(provided, expected)) {
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
