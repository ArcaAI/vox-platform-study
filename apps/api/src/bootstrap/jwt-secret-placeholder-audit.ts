import { Logger } from '@nestjs/common';
import type { SecretsService } from '@arcaai/applications';

/**
 * Boot-time JWT-secret placeholder audit.
 *
 * Mirrors the in-strategy assertion at `packages/applications/src/
 * services/auth/jwt.strategy.ts`. Called from `main.ts` AFTER
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
 * `auditAdminRoutePermissions`, which runs immediately after in `main.ts`.
 */
export function assertJwtSecretNotPlaceholder(secretsService: SecretsService): void {
  const PLACEHOLDER = 'default-jwt-secret-key-change-in-production';
  const jwtSecret = secretsService.getSecretSync('JWT_SECRET_KEY');

  if (jwtSecret === undefined || jwtSecret === PLACEHOLDER) {
    // Disambiguate "undefined" (warmup miss) from "literal placeholder" in
    // both the log AND the thrown Error so a crash-loop reading container
    // logs can pin the root cause without re-running with debug logging.
    const reason =
      jwtSecret === undefined
        ? 'JWT_SECRET_KEY is not warmed in SecretsService (undefined). Set a real secret in Vault / SecretsService before booting.'
        : 'JWT_SECRET_KEY resolved to the literal development placeholder. Replace the development default with a real secret in Vault / SecretsService.';
    new Logger('JwtSecretPlaceholderAudit').error(reason);
    throw new Error(`Refusing to boot: ${reason}`);
  }
}
