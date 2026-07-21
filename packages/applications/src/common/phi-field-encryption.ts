// Environment-gated PHI field-encryption guard, shared by every service that
// encrypts PHI on write.
//
// Encrypt-on-write runs as "best-effort" in each service (a private
// `encryptBestEffort` / `encryptContent` that silently no-ops when the
// SecretsService is missing and swallows Vault errors). That dual-write soak
// behaviour is correct for dev/test, but in staging/prod silently persisting a
// populated PHI field as plaintext-only defeats the whole encryption guarantee.
//
// This module centralises the policy so it is identical across all services:
//   - dev/test  (SECRETS_PROVIDER != 'vault') → SOFT no-op (logged, never PHI)
//   - staging/prod (SECRETS_PROVIDER == 'vault') → FAIL CLOSED (throw)
//
// Only the WRITE path is governed here. There are no plaintext PHI columns, so
// in the soft (dev/test) mode the field is simply left unencrypted-and-unpersisted
// — there is no plaintext column to fall back to. Any environment that must
// retain PHI therefore runs SECRETS_PROVIDER=vault (fail-closed); reads
// decrypt the ciphertext only.

/** Minimal logger surface — satisfied structurally by the NestJS `Logger`. */
export interface PhiEncryptLogger {
  error(message: string): void;
}

/**
 * Whether PHI field encryption is REQUIRED (must fail closed) for the current
 * environment. `SECRETS_PROVIDER=vault` denotes staging/prod (and dev per
 * `.env.dev`); anything else (`env`, unset) is treated as dev/test and stays a
 * soft no-op. Mirrors the gate the backfill scripts and `vault-prisma.module`
 * already use.
 */
export function isPhiEncryptionRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SECRETS_PROVIDER === 'vault';
}

/**
 * Run a PHI field-encryption step with environment-gated failure semantics.
 *
 * Soft mode (dev/test):
 *   - `secrets` absent → no-op (there is no plaintext column, so the field is
 *     left unpersisted; only safe where the env holds no real PHI).
 *   - `run()` throws   → swallowed + logged (message only — never PHI).
 *
 * Required mode (`SECRETS_PROVIDER=vault`):
 *   - `secrets` absent → THROW (refuse to silently persist plaintext-only PHI).
 *   - `run()` throws   → rethrow so the caller's write aborts (fail-closed).
 *
 * @param secrets the caller's SecretsService (or undefined) — only presence is checked here.
 * @param label   model/field label used in log + error messages (must never contain PHI).
 * @param run     performs the actual `encrypt<…>IntoEntity` mutation on the entity.
 * @param logger  message-only logger (the service's NestJS `Logger`).
 * @param env     injectable for tests; defaults to `process.env`.
 */
export async function encryptPhiFields(
  secrets: unknown,
  label: string,
  run: () => Promise<void>,
  logger: PhiEncryptLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const required = isPhiEncryptionRequired(env);

  if (!secrets) {
    if (required) {
      throw new Error(
        `${label} field encryption is required (SECRETS_PROVIDER=vault) but no SecretsService is available — refusing to persist plaintext-only PHI`,
      );
    }
    return;
  }

  try {
    await run();
  } catch (err) {
    if (required) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    logger.error(`${label} field encryption skipped (dual-write soak): ${err instanceof Error ? err.message : String(err)}`);
  }
}
