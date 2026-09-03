import bcryptjs from 'bcryptjs';
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID } from './00-constants';

/**
 * the day-1 bootstrap SUPER_ADMIN.
 *
 * ## The gap this closes
 *
 * `RUN_SEED=safe` is the documented production bootstrap (`seed-mode.ts:27`,
 * `deployment` `migrate.sh`). It runs every platform-configuration phase and
 * deliberately EXCLUDES `91-user`, because those are demo accounts
 * (`*@example.com`) sharing one documented password.
 *
 * The consequence nobody had closed: a `safe` seed produces **zero `User` rows
 * and zero `UserRoleAssignment` rows**. Combined with the fact that the only
 * `@Public()` auth routes are `POST /auth/login` and `POST /auth/refresh` —
 * there is no registration, no signup, and no env-driven provisioner anywhere
 * in `apps/api`, `scripts/`, `packages/applications`, `packages/database/scripts`
 * or `packages/tools` — a fresh non-development deploy had **no way to log in
 * at all**. Every other bootstrap path is circular: service-account issuance is
 * SUPER_ADMIN-only, tenant creation with an initial admin requires an
 * authenticated platform admin, and `gen-dev-token` only mints a token for a
 * user that already exists.
 *
 * ## Why env, when rule 00 says "minimise env vars"
 *
 * Because this IS the bootstrap floor that rule names. `09-infrastructure-devops.md`
 * Tiers keeps in `env` only what is needed *to reach the database
 * or authenticate to Vault*; a first-admin credential is the same class of
 * thing — the one input that cannot be read from the system it is used to
 * unlock. It is consumed EXACTLY ONCE and never read at runtime, which is why
 * it is not a `global-kv` knob.
 *
 * ## Posture
 *
 * - **CREATE-ONLY, keyed by a reserved id.** A re-seed never rewrites the row,
 *   so an operator who rotates this password (or renames the account) keeps
 *   their change. This is the opposite of `91-user.ts`, whose `update:` branch
 *   re-applies the demo password on every run.
 * - **No-op when unset.** The variables absent means "not requested" — the seed
 *   says so and moves on. It never invents a credential.
 * - **Fails loudly on partial or weak configuration**, rather than creating a
 *   guessable platform-wide administrator.
 * - **The password is never logged**, and never written anywhere but the
 *   bcrypt hash.
 * - Runs in BOTH `safe` and `all` (it is not on the `SEED_PHASES_EXCLUDED_FROM_SAFE`
 *   deny-list) — in `all` it simply sits alongside the demo `super_admin`.
 */

/** Reserved id, in the `70000000-…` user block, distinct from every `SEED_USER_IDS` entry. */
export const BOOTSTRAP_SUPER_ADMIN_USER_ID = '70000000-0000-0000-0000-0000000000ff';

export const BOOTSTRAP_ENV_VARS = {
  username: 'BOOTSTRAP_SUPER_ADMIN_USERNAME',
  email: 'BOOTSTRAP_SUPER_ADMIN_EMAIL',
  password: 'BOOTSTRAP_SUPER_ADMIN_PASSWORD',
} as const;

/**
 * Minimum length for the bootstrap password. This account holds `manage:all`
 * across every tenant, so a short value here is a platform-wide compromise.
 */
export const BOOTSTRAP_PASSWORD_MIN_LENGTH = 12;

/**
 * Values refused outright. Not a password-strength engine — just a stop on the
 * specific strings people paste when they are moving fast, including the one
 * this repository itself documents for the demo accounts.
 */
const REFUSED_PASSWORDS = new Set(['password123', 'password', 'changeme', 'admin', 'admin123', 'hope123', 'letmein', '12345678']);

export interface BootstrapAdminConfig {
  username: string;
  email: string;
  password: string;
}

/**
 * Read + validate the bootstrap configuration. Returns `null` when the operator
 * did not ask for one; THROWS when they asked for one incorrectly.
 *
 * Exported so the rules can be tested without a database.
 */
export function resolveBootstrapAdminConfig(env: NodeJS.ProcessEnv = process.env): BootstrapAdminConfig | null {
  const email = (env[BOOTSTRAP_ENV_VARS.email] ?? '').trim();
  const password = env[BOOTSTRAP_ENV_VARS.password] ?? '';
  const username = (env[BOOTSTRAP_ENV_VARS.username] ?? '').trim() || 'admin';

  if (email === '' && password === '') return null;

  // Half-configured is a mistake, not an intent. Refusing is the only way the
  // operator finds out before discovering they cannot log in.
  if (email === '') {
    throw new Error(`${BOOTSTRAP_ENV_VARS.password} is set but ${BOOTSTRAP_ENV_VARS.email} is not. Set both, or neither.`);
  }
  if (password === '') {
    throw new Error(`${BOOTSTRAP_ENV_VARS.email} is set but ${BOOTSTRAP_ENV_VARS.password} is not. Set both, or neither.`);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${BOOTSTRAP_ENV_VARS.email}="${email}" is not a valid email address.`);
  }

  // Well-known FIRST, length second. Most of the refused values are also too
  // short, and "must be at least 12 characters" invites the operator to pad
  // `password123` to `password1234` — which passes. Naming the real problem is
  // the only message that changes behaviour.
  if (REFUSED_PASSWORDS.has(password.toLowerCase())) {
    throw new Error(`${BOOTSTRAP_ENV_VARS.password} is a well-known value and is refused. Choose a unique password.`);
  }

  if (password.length < BOOTSTRAP_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `${BOOTSTRAP_ENV_VARS.password} must be at least ${BOOTSTRAP_PASSWORD_MIN_LENGTH} characters. ` +
        'This account holds manage:all across every tenant.',
    );
  }

  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error(`${BOOTSTRAP_ENV_VARS.username}="${username}" must be 3-64 characters of [a-zA-Z0-9._-].`);
  }

  return { username, email, password };
}

export const seedBootstrapAdmin = async (client: CorePrismaClient) => {
  const config = resolveBootstrapAdminConfig();

  if (!config) {
    console.log('Bootstrap admin: not requested.');
    console.log(
      `  Set ${BOOTSTRAP_ENV_VARS.email} + ${BOOTSTRAP_ENV_VARS.password} (optionally ${BOOTSTRAP_ENV_VARS.username}) ` +
        'to provision the first SUPER_ADMIN. Without it, a RUN_SEED="safe" deployment has NO account to log in with.',
    );
    return { success: true, created: false as const };
  }

  console.log('Seeding bootstrap SUPER_ADMIN...');

  // CREATE-ONLY by reserved id: never rewrite a row an operator may have
  // rotated. Checked by id AND by username, because a rename would otherwise
  // collide on the `User.username` unique index instead of skipping cleanly.
  const existingById = await client.user.findFirst({ where: { id: BOOTSTRAP_SUPER_ADMIN_USER_ID } });
  if (existingById) {
    console.log(`  Bootstrap admin already exists (username "${existingById.username}") — leaving it untouched.`);
    return { success: true, created: false as const };
  }

  const existingByUsername = await client.user.findFirst({ where: { username: config.username } });
  if (existingByUsername) {
    console.warn(
      `  ⚠️  A user named "${config.username}" already exists (id ${existingByUsername.id}) and is NOT the bootstrap row. ` +
        `Refusing to touch it. Choose a different ${BOOTSTRAP_ENV_VARS.username} if you need a separate bootstrap account.`,
    );
    return { success: true, created: false as const };
  }

  // `Role` is tenant-scoped, and the built-in roles are
  // SYSTEM-tenant rows. Pin the tenant so this never matches a customer
  // tenant's custom role that happens to be named SUPER_ADMIN.
  const superAdminRole = await client.role.findFirst({ where: { name: 'SUPER_ADMIN', tenantId: SYSTEM_TENANT_ID } });
  if (!superAdminRole) {
    // seedRole runs in every mode, so this means the chain was invoked out of
    // order. Throwing beats creating an account with no authority.
    throw new Error('Cannot seed the bootstrap admin: the SUPER_ADMIN role does not exist. Run seedRole (03-role) first.');
  }

  const now = new Date();
  const user = await client.user.create({
    data: {
      id: BOOTSTRAP_SUPER_ADMIN_USER_ID,
      username: config.username,
      password: await bcryptjs.hash(config.password, 10),
      // Stamped so the platform's password-max-age check treats this credential
      // as a normal, ageing one. NULL would mean "never expires".
      passwordChangedAt: now,
      isServiceAccount: false,
      tags: ['bootstrap'],
    },
  });

  await client.userProfile.create({
    data: {
      userId: user.id,
      firstName: 'Platform',
      lastName: 'Administrator',
      email: config.email,
    },
  });

  // SYSTEM tenant, mirroring the demo `super_admin` (91-user.ts). SUPER_ADMIN is
  // `ELEVATED_ROLES` — its authority is platform-wide, so the assignment tenant
  // is the config TIER, never a customer tenant.
  await client.userRoleAssignment.create({
    data: {
      userId: user.id,
      roleId: superAdminRole.id,
      tenantId: SYSTEM_TENANT_ID,
    },
  });

  // Never the password — only the non-secret identifiers.
  console.log(`  Created SUPER_ADMIN "${config.username}" <${config.email}> on the SYSTEM tenant.`);
  console.log(`  Change this password after first login; a re-seed will NOT reset it.`);

  return { success: true, created: true as const };
};
