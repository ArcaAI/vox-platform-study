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
  // 3. Cross-tenant carry-through — AC-3 / C-12 (TASK-309 AC-1 upgrade)
  // ---------------------------------------------------------------------------
  //
  // TASK-309 AC-1 — replaces the TASK-307 W7.A.2 stability test. The
  // older test logged in a single tenant and asserted that the rotated
  // access token kept the same tenantId — which was sufficient to pin
  // the C-12 fix but did not actively prove that rotation is BOUND to
  // the refresh token's stored tenantId (and not, say, derived from a
  // bearer header or from `user.tenantId`).
  //
  // The genuine probe in this revision:
  //
  //   1. Logs `super_admin` into BOTH `__GLOBAL__` and `ARCAAI` (the
  //      seed already grants super_admin platform-wide membership).
  //      This gives two refresh tokens for the SAME user, each bound
  //      to a different tenant in Redis.
  //   2. Confirms each login's access token actually carries the
  //      requested tenantId — sanity for the assertion that follows.
  //   3. Rotates `refreshA` (the `__GLOBAL__` token) while sending
  //      `tokenB` (the `ARCAAI` access token) as the bearer header.
  //      If a future regression made `/auth/refresh` honour the
  //      bearer (e.g. by deriving tenantId from it), the rotated token
  //      would carry the ARCAAI id — which is the cross-tenant
  //      hijack this test must catch. The current production code
  //      ignores the bearer on `/auth/refresh` and reads tenantId off
  //      the stored refresh-token record, so the rotated token must
  //      stay scoped to `__GLOBAL__`.
  //   4. Replays the original `refreshA` to trigger the RFC 6749 §10.4
  //      family-revoke path; asserts the replay 401s AND the rotated
  //      successor 401s on its next rotation (family revoked).
  //   5. Independently rotates `refreshB` — the ARCAAI family must
  //      remain untouched by the `__GLOBAL__` family revocation
  //      (cross-family isolation).
  test('TASK-309 AC-1 — refresh-token rotation is bound to the issuing tenant even when a foreign-tenant bearer is sent', async ({
    request,
  }) => {
    // ---- Step 1: dual-tenant bootstrap ----
    const globalLogin = await loginUser(
      request,
      SEEDED_USERS.superAdmin.username,
      SEEDED_USERS.superAdmin.password,
      DEFAULT_TENANT_KEY,
    );
    expect(globalLogin, 'super_admin login (__GLOBAL__) failed').toBeTruthy();

    const arcaaiLogin = await loginUser(
      request,
      SEEDED_USERS.superAdmin.username,
      SEEDED_USERS.superAdmin.password,
      'ARCAAI',
    );
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();

    const tokenA = globalLogin!.token;
    const refreshA = globalLogin!.refreshToken;
    const tokenB = arcaaiLogin!.token;
    const refreshB = arcaaiLogin!.refreshToken;

    // ---- Step 2: sanity — the two tenant ids must actually differ ----
    const tenantIdA = decodeJwtPayload(tokenA).tenantId;
    const tenantIdB = decodeJwtPayload(tokenB).tenantId;
    expect(tenantIdA, '__GLOBAL__ access token must carry a tenantId').toBeTruthy();
    expect(tenantIdB, 'ARCAAI access token must carry a tenantId').toBeTruthy();
    expect(
      tenantIdA,
      'sanity: the two logins should produce different tenantIds — otherwise this test is not actually cross-tenant',
    ).not.toBe(tenantIdB);

    // ---- Step 3: cross-tenant rotation attempt ----
    // Attacker carries refreshA (stolen from tenant __GLOBAL__) and
    // tokenB (their own ARCAAI access token), and sends the refresh
    // request with the ARCAAI bearer attached. Production must read
    // tenantId from the stored refresh record, NOT the bearer — so
    // the rotated token stays scoped to __GLOBAL__.
    const crossTenantRotation = await request.post('/api/v1/auth/refresh', {
      headers: { Authorization: `Bearer ${tokenB}` },
      data: { refreshToken: refreshA },
    });
    expect(
      crossTenantRotation.status(),
      'a refresh token is its own authority — the endpoint must rotate it regardless of the bearer',
    ).toBe(200);
    const rotatedA = await crossTenantRotation.json();
    const rotatedTenantA = decodeJwtPayload(rotatedA.token).tenantId;
    expect(
      rotatedTenantA,
      'cross-tenant carry-through: the rotated access token must stay scoped to the ORIGINAL tenant even when the bearer claims a different tenant',
    ).toBe(tenantIdA);
    expect(rotatedTenantA, 'rotated token must NOT drift to the bearer\'s tenant (ARCAAI)').not.toBe(tenantIdB);

    // ---- Step 4: replay refreshA → 401 + family revoke ----
    // refreshA was consumed in Step 3. Replaying it must trigger the
    // reuse-detection branch in RefreshTokenService.consume — return
    // 401 AND revoke every token in family A.
    const replayA = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: refreshA },
    });
    expect(replayA.status(), 'replaying a consumed refresh token must be 401').toBe(401);

    // The rotated successor (rotatedA.refreshToken) is part of family A
    // and must also be dead now — even though it has never been used.
    const followUpA = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: rotatedA.refreshToken },
    });
    expect(
      followUpA.status(),
      'family-revoke: rotated successor of the reused token must also be rejected',
    ).toBe(401);

    // ---- Step 5: cross-family isolation — refreshB still works ----
    // Revoking family A must not collaterally damage family B (the
    // ARCAAI session). The ARCAAI refresh token still rotates and the
    // rotated access token stays ARCAAI-scoped.
    const rotateB = await request.post('/api/v1/auth/refresh', {
      data: { refreshToken: refreshB },
    });
    expect(
      rotateB.status(),
      'cross-family isolation: revoking family A must not affect family B',
    ).toBe(200);
    const rotatedB = await rotateB.json();
    expect(
      decodeJwtPayload(rotatedB.token).tenantId,
      'rotated ARCAAI token must stay scoped to ARCAAI',
    ).toBe(tenantIdB);
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
