import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { SecretsService } from './SecretsService';

/**
 * @nestjs/terminus health indicator for the secrets backend (TASK-302
 * Stream B Task 2.19).
 *
 * Use case: `/readiness` returns 503 if Vault is sealed or unreachable,
 * which protects the rolling-deploy flow from sending traffic to pods
 * that cannot serve secrets.
 *
 * Detail strings (e.g. 'sealed=true initialized=true') are included in
 * the result body for operator diagnostics but never contain secret
 * material — SecretsHealth's contract guarantees the `detail` field is
 * a free-form non-secret status string.
 */
@Injectable()
export class SecretsHealthIndicator extends HealthIndicator {
  constructor(private readonly secrets: SecretsService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const h = await this.secrets.health();
    const detail: Record<string, unknown> = {
      provider: h.provider,
      latencyMs: h.latencyMs,
    };
    // Surface the stale-while-revalidate degraded latch (TASK-312 B.4 token
    // renewal / Phase 5 DB-lease renewal). `ok` stays true so readiness keeps
    // the pod in rotation, but the flag + diagnostic must reach Terminus so a
    // dashboard/alert can recycle the pod before the lease actually expires.
    if (h.degraded) {
      detail.degraded = true;
      if (h.detail) detail.detail = h.detail;
    } else if (!h.ok && h.detail) {
      detail.detail = h.detail;
    }
    const result = this.getStatus(key, h.ok, detail);
    if (!h.ok) {
      throw new HealthCheckError(`Secrets provider unhealthy: ${h.detail ?? h.provider}`, result);
    }
    return result;
  }
}
