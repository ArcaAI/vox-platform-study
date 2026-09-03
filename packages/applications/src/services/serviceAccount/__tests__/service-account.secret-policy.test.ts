/**
 * an issued client secret follows the SUPER_ADMIN-managed
 * `security.secret.*` policy, not a literal in this service.
 *
 * The two things worth pinning: the STORED policy WINS over the hardcoded
 * default, and an absent settings cache (legacy fixtures, unit graphs) still
 * produces exactly the pre-policy credential — 32 bytes as 64 hex characters.
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceAccountService } from '../service-account.service';

function makeService(settings?: Record<string, unknown>) {
  const appSettings = settings ? { getValueWithDefault: vi.fn((key: string, dflt: unknown) => (key in settings ? settings[key] : dflt)) } : undefined;
  return new ServiceAccountService(
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn() } as never,
    {} as never,
    {} as never,
    undefined,
    appSettings as never,
  );
}

describe('ServiceAccountService client-secret policy', () => {
  it('falls back to 64 hex chars when no settings cache is wired', () => {
    expect(makeService().generateClientSecret()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to 64 hex chars when the platform stored no policy', () => {
    expect(makeService({}).generateClientSecret()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('PREFERS a stored longer length over the hardcoded default', () => {
    expect(makeService({ 'security.secret.byteLength': 48 }).generateClientSecret()).toMatch(/^[a-f0-9]{96}$/);
  });

  it('PREFERS a stored alphabet over the hardcoded default', () => {
    const secret = makeService({ 'security.secret.encoding': 'base64url' }).generateClientSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses to issue below the 128-bit floor however the row is written', () => {
    expect(makeService({ 'security.secret.byteLength': 1 }).generateClientSecret()).toMatch(/^[a-f0-9]{32}$/);
  });
});
