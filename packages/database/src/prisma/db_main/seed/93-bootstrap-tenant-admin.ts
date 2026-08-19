import bcryptjs from 'bcryptjs';
import type { CorePrismaClient } from '../../../client';

/**
 * TASK-766 — the day-1 bootstrap TENANT_ADMIN.
 *
 * ## The gap this closes
 *
 * TASK-763 gave a `RUN_SEED="safe"` deployment its first SUPER_ADMIN
 * (`92-bootstrap-admin.ts`). It did not give any TENANT its administrator: the
 * only tenant-admin accounts in the chain live in `91-user.ts`
 * (`tenant_admin`, `arcaai_admin`), which is on `SEED_PHASES_EXCLUDED_FROM_SAFE`
 * because those are demo accounts sharing one documented password. So on a
 * fresh non-development deploy the ArcaAI tenant came up fully configured —
 * departments, approved prompt library, agent defaults, buckets, allowed
 * origins — with **nobody able to administer it**, and the only remedy was for
 * the platform super admin to create the account by hand.
 *
 * ## Why this is a SEPARATE phase from 92, not a parameter of it
 *
 * The two credentials answer different questions and must be independently
 * grantable: a deployment may want a tenant administrator without minting a
 * second platform super admin, and the reverse. Folding them into one
 * env-driven function would make "provision the tenant admin" imply
 * "provision a `manage:all` account", which is the exact privilege coupling the
 * TENANT_ADMIN role exists to avoid.
 *
 * ## Authority: tenant-scoped, and only tenant-scoped
 *
 * The account is assigned the seeded `TENANT_ADMIN` role with
 * `UserRoleAssignment.tenantId` = the target tenant. Every rule in
 * `tenant-full-access` is written `{ tenantId: '${context.tenantId}' }`, and
 * the role holds NONE of the ten platform-plane abilities
 * (`manage:all`, `manage:Tenant`, `manage:Role`, `manage:Policy`,
 * `manage:ServiceAccount`, `manage:UsageAnalytics`, `manage:PlatformMetrics`,
 * `manage:PrismaStudio`, `manage:AiPriceBook`, `manage:ChangelogEntry`) —
 * pinned by `__tests__/tenant-admin-authority.test.ts`, which is what makes
 * "all rights WITHIN the tenant, and none outside it" a checked fact rather
 * than a claim.
 *
 * ## Posture (identical to 92, deliberately — one bootstrap contract)
 *
 * - **No-op when unset.** Absent variables mean "not requested".
 * - **Half-configured is a hard error**, not a silent partial provision.
 * - **Well-known passwords refused BEFORE the length check**, so the message
 *   names the real problem instead of inviting a padded `password1234`.
 * - **CREATE-ONLY, keyed by a reserved id**, so a re-seed never resets a
 *   rotated credential — and checked by username too, so a rename skips
 *   cleanly instead of colliding on the unique index.
 * - **The password is never logged.**
 * - Runs in BOTH `safe` and `all` (not on `SEED_PHASES_EXCLUDED_FROM_SAFE`):
 *   being skipped in `safe` is the bug it exists to fix.
 */

/** Reserved id in the `70000000-…` user block; distinct from every `SEED_USER_IDS` entry and from `92`'s `…00ff`. */
export const BOOTSTRAP_TENANT_ADMIN_USER_ID = '70000000-0000-0000-0000-0000000000fe';

export const BOOTSTRAP_TENANT_ADMIN_ENV_VARS = {
  username: 'BOOTSTRAP_TENANT_ADMIN_USERNAME',
  email: 'BOOTSTRAP_TENANT_ADMIN_EMAIL',
  password: 'BOOTSTRAP_TENANT_ADMIN_PASSWORD',
  tenantKey: 'BOOTSTRAP_TENANT_ADMIN_TENANT_KEY',
} as const;

/**
 * The tenant this account administers when `BOOTSTRAP_TENANT_ADMIN_TENANT_KEY`
 * is not set. `Tenant.key`, not `Tenant.id`: an operator reads the key off the
 * console, and it survives a re-provisioned database where a uuid would not.
 *
 * ArcaAI is the day-1 customer tenant — it is the one that carries a clinical
 * department catalog, an approved prompt library and agent defaults.
 */
export const DEFAULT_BOOTSTRAP_TENANT_KEY = 'ARCAAI';

/** The two reserved tenants, refused as targets — neither is a customer tenant an administrator belongs to. */
const REFUSED_TENANT_KEYS = new Set(['__SYSTEM__', '__GLOBAL__']);

export const BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH = 12;

/** Same stop-list as `92-bootstrap-admin.ts`, including this repository's own demo password. */
const REFUSED_PASSWORDS = new Set(['password123', 'password', 'changeme', 'admin', 'admin123', 'hope123', 'letmein', '12345678']);

export interface BootstrapTenantAdminConfig {
  username: string;
  email: string;
  password: string;
  tenantKey: string;
}

/**
 * Read + validate the configuration. Returns `null` when the operator did not
 * ask for one; THROWS when they asked for one incorrectly.
 *
 * Exported so the rules are testable without a database.
 */
export function resolveBootstrapTenantAdminConfig(env: NodeJS.ProcessEnv = process.env): BootstrapTenantAdminConfig | null {
  const email = (env[BOOTSTRAP_TENANT_ADMIN_ENV_VARS.email] ?? '').trim();
  const password = env[BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password] ?? '';
  const username = (env[BOOTSTRAP_TENANT_ADMIN_ENV_VARS.username] ?? '').trim() || 'tenant-admin';
  const tenantKey = (env[BOOTSTRAP_TENANT_ADMIN_ENV_VARS.tenantKey] ?? '').trim() || DEFAULT_BOOTSTRAP_TENANT_KEY;

  if (email === '' && password === '') return null;

  if (email === '') {
    throw new Error(
      `${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password} is set but ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.email} is not. Set both, or neither.`,
    );
  }
  if (password === '') {
    throw new Error(
      `${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.email} is set but ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password} is not. Set both, or neither.`,
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.email}="${email}" is not a valid email address.`);
  }

  if (REFUSED_PASSWORDS.has(password.toLowerCase())) {
    throw new Error(`${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password} is a well-known value and is refused. Choose a unique password.`);
  }

  if (password.length < BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password} must be at least ${BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH} characters. ` +
        'This account holds every tenant-scoped ability inside its tenant.',
    );
  }

  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error(`${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.username}="${username}" must be 3-64 characters of [a-zA-Z0-9._-].`);
  }

  // The SYSTEM tenant is a CONFIG TIER and "Global" is a platform-admin
  // playground (`00-project-context.md` §"The two reserved tenants are NOT two
  // config tiers"). Neither is a customer whose data an administrator owns, and
  // a TENANT_ADMIN pinned to either would be administering the platform's own
  // configuration rows under a tenant-scoped role.
  if (REFUSED_TENANT_KEYS.has(tenantKey.toUpperCase())) {
    throw new Error(
      `${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.tenantKey}="${tenantKey}" is a reserved platform tenant and may not host a tenant administrator. ` +
        'Use a customer tenant key (the day-1 default is "ARCAAI").',
    );
  }

  return { username, email, password, tenantKey };
}

export const seedBootstrapTenantAdmin = async (client: CorePrismaClient) => {
  const config = resolveBootstrapTenantAdminConfig();

  if (!config) {
    console.log('Bootstrap tenant admin: not requested.');
    console.log(
      `  Set ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.email} + ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.password} ` +
        `(optionally ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.username}, ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.tenantKey}; ` +
        `tenant defaults to "${DEFAULT_BOOTSTRAP_TENANT_KEY}") to provision the first TENANT_ADMIN. ` +
        'Without it, a RUN_SEED="safe" deployment has a fully configured tenant that nobody can administer.',
    );
    return { success: true, created: false as const };
  }

  console.log('Seeding bootstrap TENANT_ADMIN...');

  const tenant = await client.tenant.findFirst({ where: { key: config.tenantKey } });
  if (!tenant) {
    // Throwing beats creating an account with an assignment to nothing: a
    // UserRoleAssignment with an unknown tenantId authenticates and then
    // resolves no abilities at all, which reads as a platform bug.
    throw new Error(
      `Cannot seed the bootstrap tenant admin: no tenant with key "${config.tenantKey}" exists. ` +
        `Run seedTenant (05-tenant) first, or set ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.tenantKey} to a seeded tenant key.`,
    );
  }

  const existingById = await client.user.findFirst({ where: { id: BOOTSTRAP_TENANT_ADMIN_USER_ID } });
  if (existingById) {
    console.log(`  Bootstrap tenant admin already exists (username "${existingById.username}") — leaving it untouched.`);
    return { success: true, created: false as const };
  }

  const existingByUsername = await client.user.findFirst({ where: { username: config.username } });
  if (existingByUsername) {
    console.warn(
      `  ⚠️  A user named "${config.username}" already exists (id ${existingByUsername.id}) and is NOT the bootstrap row. ` +
        `Refusing to touch it. Choose a different ${BOOTSTRAP_TENANT_ADMIN_ENV_VARS.username}.`,
    );
    return { success: true, created: false as const };
  }

  const tenantAdminRole = await client.role.findFirst({ where: { name: 'TENANT_ADMIN' } });
  if (!tenantAdminRole) {
    throw new Error('Cannot seed the bootstrap tenant admin: the TENANT_ADMIN role does not exist. Run seedRole (03-role) first.');
  }

  const now = new Date();
  const user = await client.user.create({
    data: {
      id: BOOTSTRAP_TENANT_ADMIN_USER_ID,
      username: config.username,
      password: await bcryptjs.hash(config.password, 10),
      // NULL would mean "never expires"; a bootstrap credential should age.
      passwordChangedAt: now,
      isServiceAccount: false,
      tags: ['bootstrap', 'tenant-admin'],
    },
  });

  await client.userProfile.create({
    data: {
      userId: user.id,
      firstName: 'Tenant',
      lastName: 'Administrator',
      email: config.email,
    },
  });

  // THE tenant scoping. `tenantId` here is what every
  // `{ tenantId: '${context.tenantId}' }` rule in `tenant-full-access` resolves
  // against — this single field is the whole difference between a tenant
  // administrator and a platform one.
  await client.userRoleAssignment.create({
    data: {
      userId: user.id,
      roleId: tenantAdminRole.id,
      tenantId: tenant.id,
    },
  });

  console.log(`  Created TENANT_ADMIN "${config.username}" <${config.email}> on tenant "${tenant.key}" (${tenant.id}).`);
  console.log('  Change this password after first login; a re-seed will NOT reset it.');

  return { success: true, created: true as const };
};
