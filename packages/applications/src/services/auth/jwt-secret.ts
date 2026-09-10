// TASK-944 lane C — the ONE resolver for the platform JWT signing/verification secret.
//
// ## Why this file exists
//
// Before it, six call sites open-coded the same two-step read and one of them did not:
//
//   • `AuthController.resolveJwtSecretKey`          sign
//   • `AuthSsoController.resolveJwtSecretKey`       sign
//   • `AdminImpersonationController` (inline)       sign
//   • `FederatedAuthService.resolveJwtSecretKey`    sign
//   • `OidcStrategy` (inline, `?? 'default-secret-key'`)   sign — see below
//   • `JwtStrategy` (constructor, captured ONCE)    VERIFY
//
// Four of them carried a comment claiming they were kept in step with the verify path.
// They were not: `JwtStrategy` read the secret in its constructor and handed passport
// the resulting STRING, so verification was pinned to the boot-time value for the life
// of the process while every mint path re-resolved on each call. Measured consequence
// on `hope-v2-dev` (2026-09-10): after a Vault rotation, `POST /auth/login` minted
// tokens signed with the NEW secret that every authenticated route then rejected with
// 401 against the OLD one — a platform-wide auth outage that only a restart cleared.
//
// `OidcStrategy` was the same defect with the opposite sign: it substituted the literal
// `'default-secret-key'` when the sync cache was cold, minting a token that NO verifier
// would ever accept. A comment cannot keep six copies in step; one function can.
//
// ## The contract
//
// Read the boot-warmed sync cache first (the common case, and the only one cheap enough
// for the verify hot path), then fall back to an async provider fetch when that entry
// has aged out. `SecretsService.getSecretSync` is cache-only BY DESIGN — it never
// lazily re-fetches — so without the fallback every consumer starts failing one
// `SECRETS_TTL_SEC` after boot.
//
// `undefined` means the provider genuinely cannot supply the secret. It is never
// papered over with a literal: each call site turns it into its own fail-closed
// refusal (401 on a mint, a verification error on the guard).

/**
 * The secret's name in `SecretsService` (and therefore its Vault kv-v2 name — the
 * `jwt.secretKey` descriptor run through `toEnvVarName()`).
 */
export const JWT_SECRET_KEY_NAME = 'JWT_SECRET_KEY';

/**
 * The literal development default. Refused at boot by `apps/api/src/main.ts` and by
 * `JwtStrategy`, so it can never reach a deployed signature.
 */
export const JWT_SECRET_PLACEHOLDER = 'default-jwt-secret-key-change-in-production';

/**
 * The minimum of `SecretsService` this resolver needs.
 *
 * Structural rather than the concrete class so `services/auth` does not have to import
 * a baseService just to state a two-method dependency, and so a test can supply a
 * mutable stand-in (which is exactly how the rotation case is exercised).
 */
export interface JwtSecretSource {
  getSecretSync(name: string): string | undefined;
  getSecretOptional(name: string): Promise<string | undefined>;
}

/**
 * Resolve the CURRENT JWT secret. Sign and verify both go through here, so they cannot
 * diverge: a rotation converges on both halves inside one `SecretsService` cache TTL
 * (or immediately, via the `arca:secrets:invalidate` subscriber), with no restart.
 */
export async function resolveJwtSecret(secretsService: JwtSecretSource): Promise<string | undefined> {
  return secretsService.getSecretSync(JWT_SECRET_KEY_NAME) ?? (await secretsService.getSecretOptional(JWT_SECRET_KEY_NAME));
}
