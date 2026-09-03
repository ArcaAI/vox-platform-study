/**
 * an issued webhook signing secret follows the SUPER_ADMIN-managed
 * `security.secret.*` policy, not a literal in this service.
 *
 * The webhook secret is the one member of the family that honours `encoding`
 * as well as `byteLength`: it is only ever an HMAC key, so no format regex
 * constrains its alphabet (contrast `apikey.secret-policy.test.ts`, where hex
 * is pinned).
 */
import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../webhook.service';

function makeService(settings?: Record<string, unknown>) {
  const appSettings = settings ? { getValueWithDefault: vi.fn((key: string, dflt: unknown) => (key in settings ? settings[key] : dflt)) } : undefined;
  return new WebhookService(
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn() } as never,
    undefined,
    appSettings as never,
  );
}

describe('WebhookService signing-secret policy', () => {
  it('falls back to 64 hex chars when no settings cache is wired', () => {
    expect(makeService().generateRawSecret()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to 64 hex chars when the platform stored no policy', () => {
    expect(makeService({}).generateRawSecret()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('PREFERS a stored longer length over the hardcoded default', () => {
    expect(makeService({ 'security.secret.byteLength': 48 }).generateRawSecret()).toMatch(/^[a-f0-9]{96}$/);
  });

  it('PREFERS a stored alphabet (no format regex constrains a signing key)', () => {
    const secret = makeService({ 'security.secret.encoding': 'base64url' }).generateRawSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses to issue below the 128-bit floor however the row is written', () => {
    expect(makeService({ 'security.secret.byteLength': 2 }).generateRawSecret()).toMatch(/^[a-f0-9]{32}$/);
  });

  it('round-trips a policy-generated secret through the reversible storage form', async () => {
    const service = makeService({ 'security.secret.byteLength': 48, 'security.secret.encoding': 'base64url' });
    const raw = service.generateRawSecret();
    expect(WebhookService.decryptSecret(WebhookService.encryptSecret(raw))).toBe(raw);
  });
});
