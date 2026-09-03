import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_TENANT_ADMIN_ENV_VARS,
  BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH,
  BOOTSTRAP_TENANT_ADMIN_USER_ID,
  DEFAULT_BOOTSTRAP_TENANT_KEY,
  resolveBootstrapTenantAdminConfig,
} from '../93-bootstrap-tenant-admin';
import { BOOTSTRAP_SUPER_ADMIN_USER_ID } from '../92-bootstrap-admin';
import { SEED_USER_IDS } from '../00-constants';

/**
 * the day-1 bootstrap TENANT_ADMIN.
 *
 * These lock the RULES, not the database write. No seed test in this repo
 * touches a live database (see `seed-idempotency.test.ts`), so the write path
 * is covered by running the seed twice against the test DB  and the
 * decision logic is covered here.
 */

const V = BOOTSTRAP_TENANT_ADMIN_ENV_VARS;
const GOOD = 'a-real-bootstrap-passphrase';

describe('resolveBootstrapTenantAdminConfig — when it does nothing', () => {
  it('is a no-op when neither email nor password is set', () => {
    expect(resolveBootstrapTenantAdminConfig({})).toBeNull();
  });

  it('is a no-op even when only the OPTIONAL variables are set', () => {
    // Setting a username or tenant key alone is not a request to provision —
    // otherwise a leftover variable in a shared env file would silently create
    // an administrator on the next deploy.
    expect(resolveBootstrapTenantAdminConfig({ [V.username]: 'ops', [V.tenantKey]: 'ARCAAI' })).toBeNull();
  });
});

describe('resolveBootstrapTenantAdminConfig — half-configured is a hard error', () => {
  it('throws when the password is set but the email is not', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.password]: GOOD })).toThrow(/EMAIL is not set|is not\. Set both/i);
  });

  it('throws when the email is set but the password is not', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test' })).toThrow(/Set both, or neither/);
  });
});

describe('resolveBootstrapTenantAdminConfig — credential quality', () => {
  it('refuses a well-known password, and says WHY rather than quoting a length rule', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: 'password123' })).toThrow(
      /well-known value/,
    );
  });

  it('refuses well-known passwords case-insensitively', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: 'ChangeMe' })).toThrow(/well-known/);
  });

  it('checks the well-known list BEFORE the length rule, so padding does not defeat it', () => {
    // `password123` padded to 12+ characters passes the length rule. If the
    // length check ran first the operator would be told to lengthen it, which
    // is exactly the wrong instruction.
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: 'password123' })).toThrow(
      /well-known/,
    );
  });

  it(`refuses a password shorter than ${BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH} characters`, () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: 'short1!x' })).toThrow(
      new RegExp(`at least ${BOOTSTRAP_TENANT_ADMIN_PASSWORD_MIN_LENGTH} characters`),
    );
  });

  it('refuses a malformed email', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'not-an-email', [V.password]: GOOD })).toThrow(/valid email/);
  });

  it('refuses a malformed username', () => {
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: GOOD, [V.username]: 'a b' })).toThrow(
      /3-64 characters/,
    );
  });
});

describe('resolveBootstrapTenantAdminConfig — the tenant it targets', () => {
  it(`defaults to the ${DEFAULT_BOOTSTRAP_TENANT_KEY} customer tenant`, () => {
    const config = resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: GOOD });
    expect(config?.tenantKey).toBe(DEFAULT_BOOTSTRAP_TENANT_KEY);
    expect(config?.username).toBe('tenant-admin');
  });

  it('accepts an explicit customer tenant key', () => {
    const config = resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: GOOD, [V.tenantKey]: 'ACME' });
    expect(config?.tenantKey).toBe('ACME');
  });

  it.each(['__SYSTEM__', '__system__', '__GLOBAL__'])('refuses the reserved tenant key %s', (key) => {
    // SYSTEM is a CONFIG TIER and "Global" is a platform-admin playground
    // (`00-project-context.md`). Neither is a customer whose data a
    // tenant-scoped administrator owns.
    expect(() => resolveBootstrapTenantAdminConfig({ [V.email]: 'ops@example.test', [V.password]: GOOD, [V.tenantKey]: key })).toThrow(
      /reserved platform tenant/,
    );
  });
});

describe('the reserved bootstrap id', () => {
  it('collides with no seeded user id', () => {
    expect(Object.values(SEED_USER_IDS)).not.toContain(BOOTSTRAP_TENANT_ADMIN_USER_ID);
  });

  it('is distinct from the bootstrap SUPER_ADMIN id', () => {
    expect(BOOTSTRAP_TENANT_ADMIN_USER_ID).not.toBe(BOOTSTRAP_SUPER_ADMIN_USER_ID);
  });
});

describe('the phase runs in every seeding mode', () => {
  it('is not on the safe-mode deny-list — being skipped in `safe` is the bug it fixes', async () => {
    const { SEED_PHASES_EXCLUDED_FROM_SAFE, isPhaseEnabled } = await import('../seed-mode');
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).not.toContain('93-bootstrap-tenant-admin');
    expect(isPhaseEnabled('93-bootstrap-tenant-admin', 'safe')).toBe(true);
    expect(isPhaseEnabled('93-bootstrap-tenant-admin', 'all')).toBe(true);
    expect(isPhaseEnabled('93-bootstrap-tenant-admin', 'none')).toBe(false);
  });
});
