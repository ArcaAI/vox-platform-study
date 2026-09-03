/**
 * generated key material follows the SUPER_ADMIN-managed
 * `security.secret.*` policy.
 *
 * The API-key-specific half of the contract is the ALPHABET PIN: `byteLength`
 * is honoured, `encoding` is deliberately not, because `KEY_FORMAT_REGEX` and
 * `extractChecksum` parse the raw key structurally. A policy-generated key that
 * the platform's own validator rejects would be worse than an unconfigurable
 * one, so every case below re-validates the key it just produced.
 */
import { describe, expect, it } from 'vitest';
import { ApiKeyType } from '@arcaai/domains';
import { ApiKeyService } from '../apikey.service';

describe('ApiKeyService.generateRawKey secret policy', () => {
  it('defaults to 64 hex characters of key material', () => {
    const key = ApiKeyService.generateRawKey(ApiKeyType.SDK);
    expect(key).toMatch(/^hope_sk_[a-f0-9]{64}_[a-f0-9]{6}$/);
    expect(ApiKeyService.isValidKeyFormat(key)).toBe(true);
  });

  it('honours a configured longer length and stays structurally valid', () => {
    const key = ApiKeyService.generateRawKey(ApiKeyType.SDK, { byteLength: 48, encoding: 'hex' });
    expect(key).toMatch(/^hope_sk_[a-f0-9]{96}_[a-f0-9]{6}$/);
    expect(ApiKeyService.isValidKeyFormat(key)).toBe(true);
  });

  it('PINS hex even when the policy asks for base64url (the format regex owns the alphabet)', () => {
    const key = ApiKeyService.generateRawKey(ApiKeyType.SDK, { byteLength: 32, encoding: 'base64url' });
    expect(key).toMatch(/^hope_sk_[a-f0-9]{64}_[a-f0-9]{6}$/);
    expect(ApiKeyService.isValidKeyFormat(key)).toBe(true);
  });

  it('keeps the checksum bound to the (longer) random part', () => {
    const key = ApiKeyService.generateRawKey(ApiKeyType.WEBHOOK, { byteLength: 40, encoding: 'hex' });
    expect(ApiKeyService.isValidKeyFormat(key)).toBe(true);
    expect(ApiKeyService.extractChecksum(key)).toHaveLength(6);
  });
});
