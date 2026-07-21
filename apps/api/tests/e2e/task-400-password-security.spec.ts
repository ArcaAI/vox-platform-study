/**
 * Password security hardening: live API contract.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack
 * via `SKIP_DB_PRECHECK=true API_URL=http://localhost:8868/api/v1`). Harness
 * mirrors task-388 (seeded `super_admin` bound to `__GLOBAL__`; throwaway
 * loginable users so no seed account is mutated).
 *
 * Coverage:
 *   A. Public forgot-password — 202 + IDENTICAL body for existing and unknown
 *      email; the token NEVER appears in the response; the reset link is read
 *      from the DEV OUTBOX file (non-prod mailer transport), never the API.
 *   B. Revocable DB-backed tokens — single-use (replay 400), a new request
 *      revokes the previous active token, an expired token is rejected
 *      (expiry is forced via an UPDATE to `expiresAt` — never a DELETE).
 *   C. Complexity policy — weak password on completion is a clear 400 listing
 *      the unmet rules; the SAME token stays consumable afterwards; the admin
 *      temporary-password path rejects a weak explicit password.
 *   D. Rotation — `security.password.maxAgeDays` GlobalSetting + a backdated
 *      `passwordChangedAt` (UPDATE) surface `passwordExpired: true` at login
 *      WITHOUT blocking the login itself.
 *
 * The admin-initiated flow's regression coverage lives in
 * `task-388-users-backend-backlog.spec.ts` (re-run alongside this file).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

/**
 * Minimal unscoped Prisma access for UPDATE-only test fixture manipulation
 * (backdating expiry / passwordChangedAt) and hash-storage assertions. The
 * shared `tests/helpers/db.helper` resolves `@arcaai/database` from the repo
 * root — which does not depend on it — so this spec imports the package dist
 * directly (same pattern the helper's own error message suggests).
 */
interface TokenRow {
  userId: string;
  tokenHash: string;
  requestedVia: string | null;
  usedAt: Date | null;
  revokedAt: Date | null;
}
interface DbClient {
  passwordResetToken: {
    findUnique(args: { where: { tokenHash: string } }): Promise<TokenRow | null>;
    update(args: { where: { tokenHash: string }; data: { expiresAt: Date } }): Promise<unknown>;
  };
  user: {
    findUnique(args: { where: { id: string }; select: { passwordChangedAt: boolean } }): Promise<{ passwordChangedAt: Date | null } | null>;
    update(args: { where: { id: string }; data: { passwordChangedAt: Date } }): Promise<unknown>;
  };
  globalSetting: {
    findFirst(args: { where: { key: string; resourceStatus: string } }): Promise<{ id: string; version: number } | null>;
  };
  $disconnect(): Promise<void>;
}

let dbClient: DbClient | null = null;
async function getDb(): Promise<DbClient> {
  if (!dbClient) {
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as DbClient;
  }
  return dbClient;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const UNIQUE = Date.now();
const CREATED_PW = 'Password123!';
const STRONG_PW = `Reset${UNIQUE}!aB`;
const GENERIC_ACK = 'If an account exists for that email, a password reset link has been sent.';
const OUTBOX_FILE = process.env.PASSWORD_RESET_OUTBOX_FILE || join(tmpdir(), 'hope-password-reset-outbox.jsonl');

let saGlobalToken: string;

interface CreatedUser {
  id: string;
  username: string;
}
interface OutboxEntry {
  email: string;
  token: string;
  resetPath: string;
  expiresInSeconds: number;
  capturedAt: string;
}

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

/** Latest dev-outbox capture for an email — the ONLY sanctioned way to obtain a self-service token. */
function latestOutboxTokenFor(email: string): OutboxEntry | null {
  if (!existsSync(OUTBOX_FILE)) return null;
  const lines = readFileSync(OUTBOX_FILE, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as OutboxEntry;
      if (entry.email?.toLowerCase() === email.toLowerCase()) return entry;
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Create a throwaway user (with a profile email) that can authenticate into __GLOBAL__. */
async function createLoginableUser(request: APIRequestContext, username: string, email: string): Promise<CreatedUser> {
  const res = await request.post('/api/v1/admin/users', {
    headers: bearer(saGlobalToken),
    data: { username, password: CREATED_PW, email },
  });
  expect(res.status(), `create throwaway user ${username}`).toBeLessThan(300);
  const u = (await res.json()) as CreatedUser;

  const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(saGlobalToken) });
  expect(rolesRes.status(), 'list roles for loginable-user setup').toBe(200);
  const roles = asArray<{ id: string; name: string }>(await rolesRes.json());
  const role = roles.find((r) => r.name === 'DOCTOR') ?? roles[0];
  expect(role, 'a seeded role exists').toBeTruthy();
  const assignRole = await request.post(`/api/v1/admin/users/${u.id}/roles`, { headers: bearer(saGlobalToken), data: { roleId: role.id } });
  expect([200, 201], 'assign role to throwaway user').toContain(assignRole.status());

  const deptRes = await request.get('/api/v1/admin/departments', { headers: bearer(saGlobalToken) });
  expect(deptRes.status(), 'list departments for loginable-user setup').toBe(200);
  const depts = asArray<{ id: string }>(await deptRes.json());
  expect(depts.length, 'a seeded department exists').toBeGreaterThan(0);
  const assignDept = await request.post(`/api/v1/admin/users/${u.id}/departments`, {
    headers: bearer(saGlobalToken),
    data: { departmentId: depts[0].id, isPrimary: true },
  });
  expect([200, 201], 'assign department to throwaway user').toContain(assignDept.status());

  return u;
}

async function deleteUser(request: APIRequestContext, id: string | undefined): Promise<void> {
  if (!id) return;
  await request.delete(`/api/v1/admin/users/${id}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
}

const forgot = (request: APIRequestContext, email: string) => request.post('/api/v1/auth/forgot-password', { data: { email } });
const complete = (request: APIRequestContext, token: string, newPassword: string) =>
  request.post('/api/v1/users/password-reset/complete', { data: { token, newPassword } });

test.beforeAll(async ({ request }) => {
  const saG = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  saGlobalToken = saG!.token;
});

test.afterAll(async () => {
  await dbClient?.$disconnect().catch(() => undefined);
});

// =============================================================================
// A — public forgot-password (anti-enumeration + email-only token delivery)
// =============================================================================
test.describe.serial('TASK-400 A — public forgot-password', () => {
  let user: CreatedUser;
  const email = `t400.forgot.${UNIQUE}@example.com`;

  test.beforeAll(async ({ request }) => {
    user = await createLoginableUser(request, `t400forgot_${UNIQUE}`, email);
  });
  test.afterAll(async ({ request }) => deleteUser(request, user?.id));

  test('A1 — 202 + identical generic body for existing AND unknown email; no token in either response', async ({ request }) => {
    const known = await forgot(request, email);
    const unknown = await forgot(request, `t400.ghost.${UNIQUE}@example.com`);

    expect(known.status(), 'known email → 202').toBe(202);
    expect(unknown.status(), 'unknown email → 202').toBe(202);

    const knownBody = await known.json();
    const unknownBody = await unknown.json();
    expect(knownBody).toEqual({ success: true, message: GENERIC_ACK });
    expect(unknownBody, 'anti-enumeration: byte-identical bodies').toEqual(knownBody);

    expect(JSON.stringify(knownBody)).not.toMatch(/token|reset-password\?/i);
  });

  test('A2 — the reset link lands in the dev outbox (email transport), never the API response', async () => {
    const entry = latestOutboxTokenFor(email);
    expect(entry, `outbox entry for ${email} exists at ${OUTBOX_FILE}`).toBeTruthy();
    expect(entry!.token.length, 'raw token is high-entropy').toBeGreaterThanOrEqual(32);
    expect(entry!.resetPath).toContain('/reset-password?token=');
    expect(entry!.expiresInSeconds).toBe(3600);
  });

  test('A3 — unknown email produced NO outbox entry', async () => {
    expect(latestOutboxTokenFor(`t400.ghost.${UNIQUE}@example.com`)).toBeNull();
  });

  test('A4 — only the SHA-256 hash is persisted; provenance is self-service', async () => {
    const entry = latestOutboxTokenFor(email);
    const prisma = await getDb();
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(entry!.token) } });
    expect(row, 'DB row keyed by hash exists').toBeTruthy();
    expect(row!.userId).toBe(user.id);
    expect(row!.requestedVia).toBe('self-service');
    expect(row!.usedAt).toBeNull();
    expect(row!.revokedAt).toBeNull();
    // The raw token itself must never be stored.
    expect(row!.tokenHash).not.toBe(entry!.token);
  });

  test('A5 — completion with the emailed token sets the password; the new password logs in; replay is 400', async ({ request }) => {
    const entry = latestOutboxTokenFor(email);
    const done = await complete(request, entry!.token, STRONG_PW);
    expect(done.status(), 'completion → 200').toBe(200);

    const relog = await loginUser(request, user.username, STRONG_PW, DEFAULT_TENANT_KEY);
    expect(relog, 'the newly-set password authenticates').toBeTruthy();

    const replay = await complete(request, entry!.token, `${STRONG_PW}x`);
    expect(replay.status(), 'single-use: a spent token is 400').toBe(400);

    const prisma = await getDb();
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(entry!.token) } });
    expect(row!.usedAt, 'usedAt stamped (UPDATE, not DELETE)').toBeTruthy();
  });
});

// =============================================================================
// B — revocation + expiry
// =============================================================================
test.describe.serial('TASK-400 B — revocation + expiry', () => {
  let user: CreatedUser;
  const email = `t400.revoke.${UNIQUE}@example.com`;

  test.beforeAll(async ({ request }) => {
    user = await createLoginableUser(request, `t400revoke_${UNIQUE}`, email);
  });
  test.afterAll(async ({ request }) => deleteUser(request, user?.id));

  test('B1 — a newer request revokes the previous token (old 400, new completes)', async ({ request }) => {
    expect((await forgot(request, email)).status()).toBe(202);
    const first = latestOutboxTokenFor(email)!;

    expect((await forgot(request, email)).status()).toBe(202);
    const second = latestOutboxTokenFor(email)!;
    expect(second.token, 'a fresh token was minted').not.toBe(first.token);

    const prisma = await getDb();
    const firstRow = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(first.token) } });
    expect(firstRow!.revokedAt, 'previous token revoked via UPDATE revokedAt').toBeTruthy();

    const oldTry = await complete(request, first.token, STRONG_PW);
    expect(oldTry.status(), 'revoked token → 400').toBe(400);

    const fresh = await complete(request, second.token, STRONG_PW);
    expect(fresh.status(), 'newest token completes').toBe(200);
  });

  test('B2 — an expired token is rejected (expiry forced via UPDATE expiresAt)', async ({ request }) => {
    expect((await forgot(request, email)).status()).toBe(202);
    const entry = latestOutboxTokenFor(email)!;

    const prisma = await getDb();
    await prisma.passwordResetToken.update({
      where: { tokenHash: sha256(entry.token) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expired = await complete(request, entry.token, `${STRONG_PW}z1`);
    expect(expired.status(), 'expired token → 400').toBe(400);
    expect(((await expired.json()) as { message?: string }).message).toMatch(/invalid or has expired/i);
  });

  test('B3 — admin double-mint also revokes: only the newest admin link completes', async ({ request }) => {
    const mint = () => request.post(`/api/v1/admin/users/${user.id}/reset-password`, { headers: bearer(saGlobalToken), data: { mode: 'link' } });

    const one = (await (await mint()).json()) as { token: string };
    const two = (await (await mint()).json()) as { token: string };

    expect((await complete(request, one.token, `${STRONG_PW}q2`)).status(), 'older admin link is revoked').toBe(400);
    expect((await complete(request, two.token, `${STRONG_PW}q2`)).status(), 'newest admin link completes').toBe(200);
  });
});

// =============================================================================
// C — complexity policy on completion + admin temporary path
// =============================================================================
test.describe.serial('TASK-400 C — complexity policy', () => {
  let user: CreatedUser;
  const email = `t400.policy.${UNIQUE}@example.com`;

  test.beforeAll(async ({ request }) => {
    user = await createLoginableUser(request, `t400policy_${UNIQUE}`, email);
  });
  test.afterAll(async ({ request }) => deleteUser(request, user?.id));

  test('C1 — weak password on completion → clear 400 listing unmet rules; token stays consumable', async ({ request }) => {
    expect((await forgot(request, email)).status()).toBe(202);
    const entry = latestOutboxTokenFor(email)!;

    const short = await complete(request, entry.token, 'short');
    expect(short.status()).toBe(400);
    const shortMsg = ((await short.json()) as { message: string }).message;
    expect(shortMsg).toMatch(/12 characters/);

    const noSpecial = await complete(request, entry.token, 'Weakpassword1');
    expect(noSpecial.status()).toBe(400);
    expect(((await noSpecial.json()) as { message: string }).message).toMatch(/special character/i);

    // The failed attempts must NOT have consumed the token.
    const ok = await complete(request, entry.token, STRONG_PW);
    expect(ok.status(), 'the same token still completes with a compliant password').toBe(200);
  });

  test('C2 — admin temporary-password path rejects a weak explicit password with 400', async ({ request }) => {
    const weak = await request.post(`/api/v1/admin/users/${user.id}/reset-password`, {
      headers: bearer(saGlobalToken),
      data: { mode: 'temporary', temporaryPassword: 'Weakpass1' },
    });
    expect(weak.status(), 'policy 400 on the admin set path').toBe(400);

    const generated = await request.post(`/api/v1/admin/users/${user.id}/reset-password`, {
      headers: bearer(saGlobalToken),
      data: { mode: 'temporary' },
    });
    expect(generated.status(), 'server-generated temp password passes its own policy').toBe(200);
    const body = (await generated.json()) as { temporaryPassword: string };
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(12);

    const relog = await loginUser(request, user.username, body.temporaryPassword, DEFAULT_TENANT_KEY);
    expect(relog, 'generated temp password authenticates').toBeTruthy();
  });

  test('C3 — completion stamps passwordChangedAt (rotation bookkeeping)', async () => {
    const prisma = await getDb();
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordChangedAt: true } });
    expect(row!.passwordChangedAt, 'passwordChangedAt stamped by the reset paths').toBeTruthy();
  });
});

// =============================================================================
// D — rotation surfaced at login (warning-only, opt-in via GlobalSettings)
// =============================================================================
test.describe.serial('TASK-400 D — rotation warning at login', () => {
  let user: CreatedUser;
  let settingId: string | undefined;
  let loginPw: string;
  const email = `t400.rotate.${UNIQUE}@example.com`;

  test.beforeAll(async ({ request }) => {
    user = await createLoginableUser(request, `t400rotate_${UNIQUE}`, email);
    // Admin-created users store the raw create payload password (login uses
    // bcrypt.compare), so a creation-time password is NOT loginable. Give the
    // user a real bcrypt password through the admin temporary flow — which is
    // also the path that stamps `passwordChangedAt` for the rotation check.
    const temp = await request.post(`/api/v1/admin/users/${user.id}/reset-password`, {
      headers: bearer(saGlobalToken),
      data: { mode: 'temporary' },
    });
    expect([200, 201], 'set temporary password for rotation-block user').toContain(temp.status());
    loginPw = ((await temp.json()) as { temporaryPassword: string }).temporaryPassword;
    expect(loginPw, 'temporary password returned to the admin').toBeTruthy();
  });
  test.afterAll(async ({ request }) => {
    if (settingId) {
      // Restore rotation-off by flipping the VALUE back to 0 — never delete.
      // A soft-DELETED row + a later re-create would leave two platform rows
      // for the same key, which trips the AppSettings boot invariant
      // and silently breaks every subsequent cache refresh.
      const prisma = await getDb();
      const row = await prisma.globalSetting
        .findFirst({ where: { key: 'security.password.maxAgeDays', resourceStatus: 'ENABLED' } })
        .catch(() => null);
      if (row) {
        await request
          .patch(`/api/v1/admin/settings/${row.id}`, {
            headers: { ...bearer(saGlobalToken), 'If-Match': `"${row.version}"` },
            data: { value: '0' },
          })
          .catch(() => undefined);
      }
    }
    await deleteUser(request, user?.id);
  });

  test('D1 — default (rotation off): login carries NO passwordExpired flag', async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', {
      data: { username: user.username, password: loginPw, tenantKey: DEFAULT_TENANT_KEY },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { passwordExpired?: boolean };
    expect(body.passwordExpired, 'rotation disabled by default').toBeUndefined();
  });

  test('D2 — maxAgeDays=1 + backdated passwordChangedAt → passwordExpired: true, login still 200', async ({ request }) => {
    test.setTimeout(150_000); // AppSettings cache refresh cron fires every ~45-60s.

    // Backdate the rotation stamp (UPDATE only, throwaway user).
    const prisma = await getDb();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordChangedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });

    // Opt rotation in via the GlobalSettings surface (platform tenant).
    // UPSERT semantics: reuse an existing row for the key (flip its value)
    // and only create when absent — a second row for the same platform key
    // would trip the AppSettings duplicate-key boot invariant.
    const existing = await prisma.globalSetting.findFirst({
      where: { key: 'security.password.maxAgeDays', resourceStatus: 'ENABLED' },
    });
    if (existing) {
      const upd = await request.patch(`/api/v1/admin/settings/${existing.id}`, {
        headers: { ...bearer(saGlobalToken), 'If-Match': `"${existing.version}"` },
        data: { value: '1' },
      });
      expect(upd.status(), 'flip security.password.maxAgeDays to 1').toBe(200);
      settingId = existing.id;
    } else {
      const create = await request.post('/api/v1/admin/settings', {
        headers: bearer(saGlobalToken),
        data: {
          name: 'security.password.maxAgeDays (rotation window, days; 0 = off)',
          key: 'security.password.maxAgeDays',
          value: '1',
          dataType: 'Integer',
          namespace: 'security',
        },
      });
      expect(create.status(), 'create security.password.maxAgeDays').toBe(201);
      settingId = ((await create.json()) as { id: string }).id;
    }

    // Poll login until the cache refresh (45s cron) picks the setting up.
    let flagged = false;
    let lastStatus = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const res = await request.post('/api/v1/auth/login', {
        data: { username: user.username, password: loginPw, tenantKey: DEFAULT_TENANT_KEY },
      });
      lastStatus = res.status();
      expect(lastStatus, 'rotation NEVER blocks login').toBe(200);
      const body = (await res.json()) as { passwordExpired?: boolean };
      if (body.passwordExpired === true) {
        flagged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(flagged, 'passwordExpired: true surfaced after the settings cache refreshed').toBe(true);
  });
});
