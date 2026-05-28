import { Logger } from '@nestjs/common';
import type { SecretsService } from '@arcaai/applications';

/**
 * TASK-307 W2.2 (closes audit C-6 part 2) — boot-time JWT-secret
 * placeholder audit.
 *
 * Mirrors the in-strategy assertion at `packages/applications/src/
 * services/auth/jwt.strategy.ts` (W2.1). Called from `main.ts` AFTER
 * `await secretsService.boot({ warmupKeys: ['JWT_SECRET_KEY', …] })`
 * resolves, so a misconfigured deploy fails BEFORE Nest finishes
 * wiring — defense-in-depth (strategy + bootstrap both refuse the
 * placeholder).
 *
 * Throws on:
 *   1. The literal placeholder `'default-jwt-secret-key-change-in-
 *      production'`. Catches the case where the real secret store
 *      contains the dev default.
 *   2. `undefined` (warmup miss). `SecretsService.boot()` logs a WARN
 *      but does NOT throw on warmup failure, so this is the bootstrap
 *      layer that turns the WARN into a hard refusal.
 *
 * Throwing here propagates out of `bootstrap()` and exits the process
 * non-zero before `app.listen()`. Same posture as
 * `auditAdminRoutePermissions` immediately below it.
 */
export function assertJwtSecretNotPlaceholder(secretsService: SecretsService): void {
  const PLACEHOLDER = 'default-jwt-secret-key-change-in-production';
  const jwtSecret = secretsService.getSecretSync('JWT_SECRET_KEY');

  if (jwtSecret === undefined || jwtSecret === PLACEHOLDER) {
    new Logger('JwtSecretPlaceholderAudit').error(
      jwtSecret === undefined
        ? 'JWT_SECRET_KEY is not warmed in SecretsService. Set a real secret in Vault / SecretsService before booting.'
        : 'JWT_SECRET_KEY resolved to the literal placeholder. Replace the development default with a real secret in Vault / SecretsService.',
    );
    throw new Error(
      'JWT_SECRET_KEY is the literal placeholder; refusing to boot. Set a real secret in Vault / SecretsService.',
    );
  }
}
