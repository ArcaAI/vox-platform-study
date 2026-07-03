/**
 * TASK-409 — break-glass second confirmation for dangerous-but-allowed RBAC
 * mutations (policy delete, role delete, detach-from-role, multi-role rule
 * edits).
 *
 * Reuses the TASK-396 step-up primitives: the caller re-proves identity with
 * their CURRENT password (verified via `ICryptoService` against the stored
 * bcrypt hash — never logged, never persisted) and additionally types the
 * exact name of the policy/role being mutated (`confirmationName`), the same
 * "type the name to confirm" contract GitHub uses for repo deletion.
 *
 * Error contract (pinned by the TASK-409 unit + E2E matrices):
 *   • missing password or confirmationName → 428 Precondition Required
 *     (RFC 6585 §3 — "you forgot the confirmation", distinct from "wrong")
 *   • wrong password                       → 401 Unauthorized
 *   • wrong confirmationName               → 400 Bad Request
 *
 * The check NEVER overrides the anti-lockout guard: absolutely-protected
 * policies (`isProtected === true` OR legacy name match) are rejected with
 * 403 BEFORE break-glass is even evaluated.
 */
import { BadRequestException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/** `data.action` discriminator on every forced break-glass audit row. */
export const RBAC_BREAK_GLASS_AUDIT_ACTION = 'RBAC_BREAK_GLASS';

/** Step-up credentials accompanying a dangerous RBAC mutation. */
export interface BreakGlassCredentials {
  /** Caller's CURRENT password (verified against the stored hash). */
  password?: string;
  /** Must exactly match the target policy/role name. */
  confirmationName?: string;
}

export type BreakGlassOutcome =
  | 'confirmed'
  | 'rejected-missing-credentials'
  | 'rejected-unauthenticated'
  | 'rejected-wrong-password'
  | 'rejected-wrong-name'
  | 'rejected-protected';

/**
 * Flat shape (not a discriminated union) because `@arcaai/config-ts/nestjs`
 * compiles with `strictNullChecks: false`, which disables union narrowing.
 * `error` is always set when `ok` is false.
 */
export interface BreakGlassCheckResult {
  ok: boolean;
  outcome: BreakGlassOutcome;
  error?: HttpException;
}

/**
 * Pure verification (no audit side-effects — callers audit the outcome so the
 * event carries service-specific target/tenant attribution). Returns a result
 * object instead of throwing so callers can audit BEFORE surfacing the error.
 */
export async function checkBreakGlass(args: {
  /** Human label used in error messages, e.g. `Deleting policy 'x'`. */
  operation: string;
  /** The exact name `confirmationName` must match. */
  expectedName: string;
  /** Authenticated caller id from CLS (null → unauthenticated). */
  userId: string | null | undefined;
  credentials: BreakGlassCredentials | undefined;
  /** Loads the caller's stored password hash (TASK-396: `user.password`). */
  loadPasswordHash: () => Promise<string>;
  /** `ICryptoService.verify` (bcrypt compare). */
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
}): Promise<BreakGlassCheckResult> {
  const { operation, expectedName, userId, credentials, loadPasswordHash, verifyPassword } = args;

  if (!credentials?.password || !credentials?.confirmationName) {
    return {
      ok: false,
      outcome: 'rejected-missing-credentials',
      // Object payload (not a bare string): the API's exception pipeline
      // annotates `getResponse()` (correlationId etc.), which requires a
      // mutable object. Shape mirrors the OCC 428 in
      // `apps/api/src/decorators/expectedVersion.decorator.ts`.
      error: new HttpException(
        {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          code: 'HTTP.PRECONDITION_REQUIRED',
          message: `${operation} requires break-glass confirmation: re-enter your current password and type the exact name to confirm.`,
        },
        HttpStatus.PRECONDITION_REQUIRED,
      ),
    };
  }

  if (!userId) {
    return {
      ok: false,
      outcome: 'rejected-unauthenticated',
      error: new UnauthorizedException('No authenticated user in context.'),
    };
  }

  const storedHash = await loadPasswordHash();
  const passwordOk = await verifyPassword(credentials.password, storedHash);
  if (!passwordOk) {
    return {
      ok: false,
      outcome: 'rejected-wrong-password',
      error: new UnauthorizedException('Break-glass re-authentication failed: incorrect password.'),
    };
  }

  if (credentials.confirmationName !== expectedName) {
    return {
      ok: false,
      outcome: 'rejected-wrong-name',
      error: new BadRequestException(`Break-glass confirmation failed: the typed name does not match '${expectedName}'.`),
    };
  }

  return { ok: true, outcome: 'confirmed' };
}
