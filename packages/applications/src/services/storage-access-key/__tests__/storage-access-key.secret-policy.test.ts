/**
 * TASK-786 — an issued storage secret access key follows the SUPER_ADMIN-managed
 * `security.secret.*` policy.
 *
 * This is the surface where generation had to MOVE layers: it lived in
 * `StorageAccessKeyFactory`, and a domain factory is DI-free by the layer
 * contract, so it could never reach the settings cache. The alphabet is pinned
 * to base64url — the shipped S3-style shape — because the platform default
 * encoding is hex and honouring it here would change the credential shape on
 * every deployment that stored no policy at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageAccessKeyService } from '../storage-access-key.service';

function makeService(settings?: Record<string, unknown>) {
  const appSettings = settings
    ? { getValueWithDefault: vi.fn((key: string, dflt: unknown) => (key in settings ? settings[key] : dflt)) }
    : undefined;
  return new StorageAccessKeyService(
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn() } as never,
    undefined,
    appSettings as never,
  );
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('StorageAccessKeyService secret policy', () => {
  it('keeps the shipped shape (32 bytes → 43 url-safe chars) with no settings cache wired', () => {
    const secret = makeService().generateRawSecret();
    expect(secret).toMatch(BASE64URL);
    expect(secret).toHaveLength(43);
  });

  it('keeps the shipped shape when the platform stored no policy', () => {
    expect(makeService({}).generateRawSecret()).toHaveLength(43);
  });

  it('PREFERS a stored longer length over the hardcoded default', () => {
    const secret = makeService({ 'security.secret.byteLength': 48 }).generateRawSecret();
    expect(secret).toMatch(BASE64URL);
    expect(secret).toHaveLength(64); // 48 bytes base64url
  });

  it('PINS base64url even when the policy asks for hex (the shipped credential shape)', () => {
    const secret = makeService({ 'security.secret.encoding': 'hex' }).generateRawSecret();
    expect(secret).toMatch(BASE64URL);
    expect(secret).toHaveLength(43);
  });

  it('refuses to issue below the 128-bit floor however the row is written', () => {
    expect(makeService({ 'security.secret.byteLength': 0 }).generateRawSecret()).toHaveLength(22); // 16 bytes
  });
});
