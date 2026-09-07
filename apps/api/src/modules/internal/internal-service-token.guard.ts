import { SecretsService } from '@arcaai/applications';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * InternalServiceTokenGuard.
 *
 * Generalizes `HarnessServiceTokenGuard` from one hardcoded secret to a
 * per-service map: the presented token is validated against the secret belonging
 * to the service named in `?service=`, so an nlp token cannot read text's config
 * subset. Same posture as the harness guard otherwise — fail-closed on a missing
 * header, an unconfigured secret, or an absent SecretsService, and a
 * constant-time compare so the token cannot be recovered by timing.
 *
 * Header: every service presents `X-Service-Token`, EXCEPT stt, which already
 * authenticates to the gateway with `X-Internal-Service-Key` + `API_GATEWAY_KEY`
 * (`apps/stt/src/stt/core/api_client/gateway.py`). Rather than mint a
 * second stt credential, the guard accepts that header for `service=stt`
 * only, matching `SttInternalController`'s existing API-key posture.
 */
@Injectable()
export class InternalServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(InternalServiceTokenGuard.name);

  /**
   * Service name → the secret holding that service's token.
   *
   * The per-service names are being retired one service at a time in favour of
   * the ONE shared `INTERNAL_ACCESS_TOKEN` (owner decision D-D): `tts` moved in
   * TASK-879/880, `text` in TASK-888. The mapping survives the migration because
   * three services have not moved yet, and because it is what makes the
   * `?service=` selector meaningful at all.
   *
   * A consequence worth stating: for the services that HAVE moved, the per-service
   * binding this guard was built for no longer separates them — `text` and `tts`
   * hold the same secret, so either can read the other's config subset. That is
   * the shared-token rule doing exactly what it says, not a hole in the guard; the
   * separation that remains is the `?service=` filter on the RESPONSE.
   */
  private static readonly SERVICE_SECRETS: Readonly<Record<string, string>> = {
    // `apps/text` stopped accepting `TEXT_SERVICE_TOKEN` when its
    // `InternalAccessConfig` was introduced — it reads `INTERNAL_ACCESS_TOKEN`
    // and nothing else — so the gateway kept admitting a credential the service
    // itself could no longer present (TASK-888).
    text: 'INTERNAL_ACCESS_TOKEN',
    nlp: 'NLP_SERVICE_TOKEN',
    guardrail: 'GUARDRAIL_SERVICE_TOKEN',
    harness: 'HARNESS_SERVICE_TOKEN',
    // tts presents the ONE shared token since its private secret was retired (TASK-879/880).
    tts: 'INTERNAL_ACCESS_TOKEN',
    stt: 'API_GATEWAY_KEY',
  };

  /** The ONE shared internal token every peer may present (owner rule: one token for all internal calls). */
  private static readonly SHARED_SECRET = 'INTERNAL_ACCESS_TOKEN';

  /** The one service that authenticates with the alternate header. */
  private static readonly ALT_HEADER_SERVICE = 'stt';

  constructor(@Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
    }>();

    const service = first(request.query?.service);
    if (!service) {
      throw new UnauthorizedException('Internal effective-config requires a `service` query parameter');
    }

    const secretName = InternalServiceTokenGuard.SERVICE_SECRETS[service];

    // An UNKNOWN service name still has to prove it is a legitimate caller —
    // otherwise the route becomes an unauthenticated service-name oracle. A
    // caller holding ANY valid service token is admitted so the read service can
    // answer the contract's 400; everyone else gets 401.
    if (!secretName) {
      if (await this.matchesAnyKnownService(request.headers)) {
        return true;
      }
      throw new UnauthorizedException('Invalid internal service token');
    }

    const provided = this.readToken(request.headers, service);
    if (!provided) {
      throw new UnauthorizedException('Internal endpoints require an X-Service-Token header');
    }

    // The ONE shared internal token is accepted for every service, the per-service
    // secret stays as the legacy fallback — the same dual acceptance
    // `HarnessServiceTokenGuard` already applies. Peers present the shared token
    // FIRST when it is configured (`apps/harness` `peer_service_token()`), so a
    // guard that admitted only the legacy secret 401'd every durable `core.agent`
    // node on `/internal/agents/resolve` (measured 2026-09-07).
    const candidates: string[] = [];
    for (const name of new Set([InternalServiceTokenGuard.SHARED_SECRET, secretName])) {
      const value = await this.secretsService?.getSecretOptional(name);
      if (value) {
        candidates.push(value);
      }
    }
    if (candidates.length === 0) {
      this.logger.error(`${secretName} is not configured — rejecting internal request for '${service}' (fail-closed)`);
      throw new UnauthorizedException('Internal service authentication is not configured');
    }

    if (!candidates.some((expected) => safeEqual(provided, expected))) {
      throw new UnauthorizedException('Invalid X-Service-Token');
    }

    return true;
  }

  /** stt may present its gateway key; every other service must use X-Service-Token. */
  private readToken(headers: Record<string, string | string[] | undefined>, service: string): string | undefined {
    if (service === InternalServiceTokenGuard.ALT_HEADER_SERVICE) {
      return first(headers['x-internal-service-key']) ?? first(headers['x-service-token']);
    }
    return first(headers['x-service-token']);
  }

  private async matchesAnyKnownService(headers: Record<string, string | string[] | undefined>): Promise<boolean> {
    const provided = first(headers['x-service-token']) ?? first(headers['x-internal-service-key']);
    if (!provided) {
      return false;
    }

    for (const secretName of Object.values(InternalServiceTokenGuard.SERVICE_SECRETS)) {
      const expected = await this.secretsService?.getSecretOptional(secretName);
      if (expected && safeEqual(provided, expected)) {
        return true;
      }
    }
    return false;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
