import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_ENV_VARS,
  BOOTSTRAP_PASSWORD_MIN_LENGTH,
  BOOTSTRAP_SUPER_ADMIN_USER_ID,
  resolveBootstrapAdminConfig,
} from '../92-bootstrap-admin';
import { SEED_USER_IDS } from '../00-constants';
import { SEED_PHASES_EXCLUDED_FROM_SAFE, isPhaseEnabled } from '../seed-mode';

/**
 * TASK-763 — the day-1 bootstrap administrator.
 *
 * The gap: `RUN_SEED="safe"` (the documented production bootstrap) excludes
 * `91-user`, so a fresh deployment had ZERO users and — with no registration
 * route anywhere on the gateway — no way to log in. Every other route to a
 * first admin is circular (service-account issuance is SUPER_ADMIN-only;
 * tenant creation with an initial admin needs an authenticated platform admin).
 *
 * These cases pin the RULES, which is where the risk is: a bootstrap credential
 * that is guessable, half-configured, or silently reset on the next seed is
 * worse than none at all.
 */
describe('bootstrap admin — configuration resolution', () => {
  const valid = {
    [BOOTSTRAP_ENV_VARS.email]: 'ops@hospital.example',
    [BOOTSTRAP_ENV_VARS.password]: 'a-long-enough-passphrase',
  };

  it('is a no-op when neither variable is set — it never invents a credential', () => {
    expect(resolveBootstrapAdminConfig({})).toBeNull();
  });

  it('defaults the username to `admin` when only email + password are given', () => {
    expect(resolveBootstrapAdminConfig({ ...valid })).toEqual({
      username: 'admin',
      email: 'ops@hospital.example',
      password: 'a-long-enough-passphrase',
    });
  });

  it('honours an explicit username', () => {
    const config = resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.username]: 'platform.ops' });
    expect(config?.username).toBe('platform.ops');
  });

  it('refuses a half-configured pair rather than guessing the missing half', () => {
    expect(() => resolveBootstrapAdminConfig({ [BOOTSTRAP_ENV_VARS.password]: 'a-long-enough-passphrase' })).toThrow(
      /BOOTSTRAP_SUPER_ADMIN_EMAIL is not/,
    );
    expect(() => resolveBootstrapAdminConfig({ [BOOTSTRAP_ENV_VARS.email]: 'ops@hospital.example' })).toThrow(
      /BOOTSTRAP_SUPER_ADMIN_PASSWORD is not/,
    );
  });

  it('refuses a password shorter than the minimum — this account holds manage:all everywhere', () => {
    const short = 'x'.repeat(BOOTSTRAP_PASSWORD_MIN_LENGTH - 1);
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.password]: short })).toThrow(/at least 12 characters/);
  });

  it("refuses the repository's own documented demo password", () => {
    // `91-user.ts` seeds every demo account with `password123`. Someone WILL
    // paste it here; a platform-wide administrator is the one account where
    // that must fail loudly.
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.password]: 'password123' })).toThrow(/well-known value/);
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.password]: 'PASSWORD123' })).toThrow(/well-known value/);
  });

  it('refuses a malformed email address', () => {
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.email]: 'not-an-email' })).toThrow(/not a valid email/);
  });

  it('refuses a username that would not round-trip as a login identifier', () => {
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.username]: 'has spaces' })).toThrow(/must be 3-64 characters/);
    expect(() => resolveBootstrapAdminConfig({ ...valid, [BOOTSTRAP_ENV_VARS.username]: 'ab' })).toThrow(/must be 3-64 characters/);
  });

  it('treats whitespace-only values as unset', () => {
    expect(resolveBootstrapAdminConfig({ [BOOTSTRAP_ENV_VARS.email]: '   ', [BOOTSTRAP_ENV_VARS.password]: '' })).toBeNull();
  });
});

describe('bootstrap admin — seed-chain wiring', () => {
  it('runs in `safe` mode — that is the whole point of the phase', () => {
    // `91-user` is on the deny-list because it seeds demo accounts. If this
    // phase ever joined it, the production bootstrap would be back to zero
    // users and no login.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).toContain('91-user');
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).not.toContain('92-bootstrap-admin');
    expect(isPhaseEnabled('92-bootstrap-admin', 'safe')).toBe(true);
    expect(isPhaseEnabled('92-bootstrap-admin', 'all')).toBe(true);
  });

  it('does not run when seeding is off', () => {
    expect(isPhaseEnabled('92-bootstrap-admin', 'none')).toBe(false);
  });

  it('uses a reserved id that collides with no demo user', () => {
    // CREATE-ONLY is keyed by this id, so a collision would make the seed
    // either skip silently or overwrite a demo account.
    expect(Object.values(SEED_USER_IDS)).not.toContain(BOOTSTRAP_SUPER_ADMIN_USER_ID);
  });
});
