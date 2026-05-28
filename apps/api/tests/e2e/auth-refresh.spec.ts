/**
 * Auth Refresh-Token Defense — TASK-307 W1 E2E
 *
 * Pins the AC-1 / AC-2 / AC-3 / AC-6 contract end-to-end against a running
 * API. Covers the four invariants that the unit tests can only mock:
 *
 *   1. Rotation        — every refresh issues a new (token, refreshToken)
 *                        pair, AND the prior refresh token cannot be used
 *                        again (single-use).
 *   2. Reuse-detection — replaying a consumed refresh token revokes the
 *                        entire family (RFC 6749 §10.4); the rotated
 *                        successor is ALSO rejected afterwards.
 *   3. Cross-tenant    — the refreshed access token stays scoped to the
 *      carry-through    SAME tenant that was active when the chain began,
 *                        regardless of any User.tenantId drift.
 *   4. Logout-         — after `/auth/logout`, BOTH the access token (jti
 *      revocation       revoked) and the refresh token (family revoked)
 *                        are dead. Re-using either yields 401.
 *
 * Closes audit findings:
 *   - C-1  refresh token forgery (BLOCKER)
 *   - C-11 logout doesn't revoke jti
 *   - C-12 refresh ignores tenant scope
 *   - D-10 refresh leaks userId in payload
 *   - E-1  JWT jti is predictable
 *
 * TEST DATA MANAGEMENT:
 *   - Uses seeded users (`admin` against `__GLOBAL__`, `doctor` against
 *     `__GLOBAL__`). Does NOT mutate the DB; the only side effects are
 *     transient Redis writes that self-expire within the 7-day TTL.
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, loginUser, DEFAULT_TENANT_KEY } from '../../../../tests/helpers';

interface DecodedJwt {
  id: string;
  jti: string;
  tenantId: string;
  refreshFamily?: string;
  exp: number;
  iat: number;
  // Plus whatever else the API puts in.
  [k: string]: unknown;
}

/**
 * Decode a JWT payload WITHOUT verifying the signature. We do not need to
 * verify here — the API has already done that on /auth/refresh's return
 * path. We just want to inspect the claims for invariant checks.
 */
function decodeJwtPayload(token: string): DecodedJwt {
  const parts = token.split('.');
  expect(parts.length, 'token must be a well-formed JWT').toBe(3);
  // base64url -> JSON
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload) as DecodedJwt;
}

test.describe('TASK-307 W1 — Refresh-token defense (E2E)', () => {
  // ---------------------------------------------------------------------------
  // 1. Single-use rotation — AC-1 / C-1
  // ---------------------------------------------------------------------------
  test('TASK-307 W1.7 — rotation issues a fresh pair and invalidates the prior refresh token (single-use)', async ({
    request,
  }) => {
    const login = await loginUser(
      request,
      SEEDED_USERS.admin.username,
      SEEDED_USERS.admin.password,
      DEFAULT_TENANT_KEY,
    );
    expect(login, 'admin login failed').toBeTruthy();

    const firstRefreshToken = login!.refreshToken;
    const firstAccessJti = decodeJwtPayload(login!.token).jti;

    // ---- First rotation: consume firstRefreshToken ----
    const first = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: firstRefreshToken },
    });
    expect(first.status(), 'first refresh failed').toBe(200);
    const firstRotated = await first.json();
    expect(firstRotated).toHaveProperty('token');
    expect(firstRotated).toHaveProperty('refreshToken');

    const secondAccessJti = decodeJwtPayload(firstRotated.token).jti;

    expect(firstRotated.refreshToken).not.toBe(firstRefreshToken);
    expect(secondAccessJti).not.toBe(firstAccessJti);
    // AC-6 / E-1: jti is a 32-char lowercase-hex string (randomBytes(16).hex)
    expect(secondAccessJti).toMatch(/^[0-9a-f]{32}$/);

    // ---- Replay the original refresh token ----
    // Single-use: the original token must now be rejected. The mock-side
    // implementation also triggers a family-revoke, but the wire-level
    // observable here is simply 401.
    const replay = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: firstRefreshToken },
    });
    expect(replay.status(), 'replaying a consumed refresh token must be 401').toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 2. Reuse-detection + family-revoke — AC-1 / RFC 6749 §10.4
  // ---------------------------------------------------------------------------
  test('TASK-307 W1.7 — replaying a consumed refresh token revokes the rotated successor too (family-revoke)', async ({
    request,
  }) => {
    const login = await loginUser(
      request,
      SEEDED_USERS.admin.username,
      SEEDED_USERS.admin.password,
      DEFAULT_TENANT_KEY,
    );
    expect(login, 'admin login failed').toBeTruthy();

    const original = login!.refreshToken;

    // Legitimately rotate once.
    const rotation = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: original },
    });
    expect(rotation.status(), 'initial rotation must succeed').toBe(200);
    const { refreshToken: rotated } = await rotation.json();

    // Now the attacker replays the ORIGINAL token (e.g. they scraped it
    // earlier). RefreshTokenService.consume sees a "consumed" marker for
    // its hash and revokes the entire family — including the rotated
    // successor that the legitimate user still holds.
    const attackerReplay = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: original },
    });
    expect(attackerReplay.status(), 'attacker replay must be 401').toBe(401);

    // The legitimate user now tries to rotate again — their token is dead too.
    const collateral = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: rotated },
    });
    expect(
      collateral.status(),
      'rotated successor must be revoked by family-revoke after reuse detection',
    ).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 3. Cross-tenant carry-through — AC-3 / C-12
  // ---------------------------------------------------------------------------
  //
  // TASK-307 W7.A.2 — known gap: this test verifies the *stability* contract
  // of AC-3 (the refreshed access token keeps the same tenantId as the
  // original login), which is sufficient to pin the C-12 fix today.
  // A stronger "actual rejection" probe would mint a tenant-A refresh
  // token and POST it from a tenant-B context to confirm 401, or seed a
  // multi-tenant user with assignments in two different tenants and
  // verify that a refresh stays bound to the originally-selected tenant.
  // The seed harness does not currently expose that fixture; flagged as a
  // §10 deferral in `docs/implementation/TASK-307-API-Gateway-Hardening/
  // README.md` for a future E2E enhancement.
  test('TASK-307 W1.7 — refreshed access token stays scoped to the original issuing tenant', async ({
    request,
  }) => {
    // tenant_admin logs in scoped to __GLOBAL__. The refreshed token MUST
    // remain scoped to __GLOBAL__'s tenant id, NOT default to whatever
    // User.tenantId currently resolves to (which is the audit finding C-12).
    const login = await loginUser(
      request,
      SEEDED_USERS.admin.username,
      SEEDED_USERS.admin.password,
      DEFAULT_TENANT_KEY,
    );
    expect(login, 'admin login failed').toBeTruthy();

    const originalTenantId = decodeJwtPayload(login!.token).tenantId;
    expect(originalTenantId, 'login token must carry a tenantId').toBeDefined();

    const rotation = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: login!.refreshToken },
    });
    expect(rotation.status(), 'rotation must succeed').toBe(200);
    const { token: rotatedAccessToken } = await rotation.json();

    const rotatedTenantId = decodeJwtPayload(rotatedAccessToken).tenantId;
    expect(rotatedTenantId, 'rotated access token preserves the original tenant scope').toBe(
      originalTenantId,
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Logout revokes both jti and refresh family — AC-2 / C-11
  // ---------------------------------------------------------------------------
  test('TASK-307 W1.7 — logout revokes the access-token jti (subsequent /auth/me is 401)', async ({
    request,
  }) => {
    const login = await loginUser(
      request,
      SEEDED_USERS.doctor.username,
      SEEDED_USERS.doctor.password,
      DEFAULT_TENANT_KEY,
    );
    expect(login, 'doctor login failed').toBeTruthy();

    // Sanity: the token works pre-logout.
    const preLogoutMe = await request.get('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${login!.token}` },
    });
    expect(preLogoutMe.status(), '/auth/me must work pre-logout').toBe(200);

    // Logout.
    const logout = await request.post('/api/v1/auth/logout', {
      headers: { Authorization: `Bearer ${login!.token}` },
    });
    expect(logout.status(), 'logout must succeed').toBe(200);

    // /auth/me must now reject the same token — jti is on the revocation set.
    const postLogoutMe = await request.get('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${login!.token}` },
    });
    expect(postLogoutMe.status(), '/auth/me with a revoked token must be 401').toBe(401);
  });

  test('TASK-307 W1.7 — logout revokes the refresh-token family (subsequent /auth/refresh is 401)', async ({
    request,
  }) => {
    const login = await loginUser(
      request,
      SEEDED_USERS.doctor.username,
      SEEDED_USERS.doctor.password,
      DEFAULT_TENANT_KEY,
    );
    expect(login, 'doctor login failed').toBeTruthy();

    // Logout — the controller reads `refreshFamily` from the JWT and calls
    // RefreshTokenService.revokeFamily under the hood.
    const logout = await request.post('/api/v1/auth/logout', {
      headers: { Authorization: `Bearer ${login!.token}` },
    });
    expect(logout.status(), 'logout must succeed').toBe(200);

    // The refresh token issued at login is now dead — its family was revoked.
    const refreshAttempt = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: login!.refreshToken },
    });
    expect(
      refreshAttempt.status(),
      'refresh after logout must be 401 (family revoked)',
    ).toBe(401);
  });
});
