/**
 * TASK-1056 — the reset link's origin is the `console.publicBaseUrl` setting (tenant → SYSTEM),
 * never an env var and never a hardcoded localhost. Unset ⇒ no absolute link, no email, and the
 * reset itself still succeeds (the admin response carries the relative path).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { UserPasswordService } from '../userPassword.service';
import { CONSOLE_PUBLIC_BASE_URL_KEY, CONSOLE_PUBLIC_URL_SETTINGS } from '../../../settings-registry/descriptors/console-public-url.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';

const cls = { get: vi.fn(), set: vi.fn() };
const users = { findById: vi.fn(), findFirst: vi.fn(), update: vi.fn() };
const profiles = { findAll: vi.fn() };
const tokens = {
  create: vi.fn(async (e: unknown) => e),
  update: vi.fn(),
  findByTokenHash: vi.fn(),
  findActiveForUser: vi.fn(async () => []),
};
const mailer = { sendResetLink: vi.fn(async () => true) };
const appSettings = { getValueWithDefault: vi.fn(<T>(_k: string, d: T): T => d) };

/** Fake cascade: tenant row → SYSTEM row → fail-closed throw (the real descriptor has no default). */
function tenantSettings(rows: { tenant?: Record<string, string>; system?: string }) {
  return {
    resolve: vi.fn((key: string, tenantId: string | null) => {
      expect(key).toBe(CONSOLE_PUBLIC_BASE_URL_KEY);
      if (tenantId && rows.tenant?.[tenantId]) return { key, value: rows.tenant[tenantId], source: 'tenant' };
      if (rows.system) return { key, value: rows.system, source: 'system' };
      throw new ArgumentInvalidException('fail-closed');
    }),
  };
}

const build = (ts?: ReturnType<typeof tenantSettings>) =>
  new UserPasswordService(
    users as never,
    profiles as never,
    tokens as never,
    { hash: vi.fn(async (p: string) => `h:${p}`) } as never,
    appSettings as never,
    { emit: vi.fn() } as never,
    cls as never,
    mailer as never,
    ts as never,
  );

const user = { id: 'user-1', isServiceAccount: false, UserProfile: { email: 'u@example.com' } };

describe('TASK-1056 console.publicBaseUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.findById.mockResolvedValue(user);
    users.findFirst.mockResolvedValue(user);
    cls.get.mockImplementation((k: string) => (k === 'tenantId' ? 'tenant-a' : null));
  });

  it('the acting tenant value wins over the platform value', async () => {
    const ts = tenantSettings({ tenant: { 'tenant-a': 'https://clinic-a.example.com/' }, system: 'https://admin.taphuynh.dev' });
    const result = await build(ts).createResetLink('user-1');

    expect(ts.resolve).toHaveBeenCalledWith(CONSOLE_PUBLIC_BASE_URL_KEY, 'tenant-a');
    expect(result.resetPath).toBe(`https://clinic-a.example.com/reset-password?token=${encodeURIComponent(result.token)}`);
    expect(mailer.sendResetLink).toHaveBeenCalledWith(expect.objectContaining({ resetUrl: result.resetPath }));
  });

  it('falls back to the platform value when the tenant has no opinion', async () => {
    const result = await build(tenantSettings({ system: 'https://admin.taphuynh.dev' })).createResetLink('user-1');
    expect(result.resetPath.startsWith('https://admin.taphuynh.dev/reset-password?token=')).toBe(true);
  });

  it('unset at both tiers: relative path, no email, reset still succeeds — never localhost', async () => {
    const result = await build(tenantSettings({})).createResetLink('user-1');

    expect(result.resetPath).toBe(`/reset-password?token=${encodeURIComponent(result.token)}`);
    expect(result.emailSent).toBe(false);
    expect(mailer.sendResetLink).not.toHaveBeenCalled();
    expect(tokens.create).toHaveBeenCalledTimes(1);
  });

  it('an unwired settings service degrades the same way', async () => {
    const result = await build(undefined).createResetLink('user-1');
    expect(result.resetPath.startsWith('/reset-password?token=')).toBe(true);
    expect(mailer.sendResetLink).not.toHaveBeenCalled();
  });

  it('self-service forgot-password resolves the PLATFORM tier (no tenant context, Host never trusted)', async () => {
    cls.get.mockReturnValue(null);
    profiles.findAll.mockResolvedValue([{ userId: 'user-1', email: 'u@example.com' }]);
    const ts = tenantSettings({ tenant: { 'tenant-a': 'https://clinic-a.example.com' }, system: 'https://admin.taphuynh.dev' });

    await build(ts).requestSelfServiceReset({ email: 'u@example.com' });

    expect(ts.resolve).toHaveBeenCalledWith(CONSOLE_PUBLIC_BASE_URL_KEY, null);
    const payload = (mailer.sendResetLink.mock.calls[0] as unknown as [{ resetUrl: string }])[0];
    expect(payload.resetUrl.startsWith('https://admin.taphuynh.dev/reset-password?token=')).toBe(true);
  });
});

describe('TASK-1056 descriptor', () => {
  const descriptor = CONSOLE_PUBLIC_URL_SETTINGS[0];

  it('is registered, tenant-overridable, fail-closed, with no default', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(CONSOLE_PUBLIC_BASE_URL_KEY)).toBe(descriptor);
    expect(descriptor).toMatchObject({ tier: 'global-kv', dataType: 'string', maxScope: 'tenant', failMode: 'closed' });
    expect(descriptor.default).toBeUndefined();
  });

  it.each(['https://admin.taphuynh.dev', 'https://admin.taphuynh.dev/', 'http://localhost:5176'])('accepts the origin %s', (v) => {
    expect(descriptor.validate!(v)).toBeUndefined();
  });

  it.each(['admin.taphuynh.dev', 'https://admin.taphuynh.dev/console', 'https://x.dev?a=1', 'javascript:alert(1)', 'ftp://x.dev', ''])(
    'refuses %s',
    (v) => {
      expect(typeof descriptor.validate!(v)).toBe('string');
    },
  );
});
