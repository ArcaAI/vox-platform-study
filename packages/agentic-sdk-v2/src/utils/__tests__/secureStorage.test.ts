/**
 * SecureStorage Unit Tests (SEC-02)
 *
 * Tests for encrypted localStorage wrapper using Web Crypto API.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SecureStorage } from '../secureStorage';

describe('SecureStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should encrypt and decrypt a value round-trip', async () => {
    const storage = await SecureStorage.create('test-passphrase');

    await storage.setItem('test-key', '{"sensitive": "data"}');
    const result = await storage.getItem('test-key');

    expect(result).toBe('{"sensitive": "data"}');
  });

  it('should store encrypted data that differs from plaintext', async () => {
    const storage = await SecureStorage.create('test-passphrase');
    const plaintext = '{"patientId": "P-12345", "diagnosis": "diabetes"}';

    await storage.setItem('medical-data', plaintext);

    const raw = localStorage.getItem('medical-data');
    expect(raw).not.toBeNull();
    expect(raw).not.toBe(plaintext);
    expect(raw).not.toContain('P-12345');
    expect(raw).not.toContain('diabetes');
  });

  it('should return null for non-existent keys', async () => {
    const storage = await SecureStorage.create('test-passphrase');

    const result = await storage.getItem('non-existent');
    expect(result).toBeNull();
  });

  it('should remove items', async () => {
    const storage = await SecureStorage.create('test-passphrase');

    await storage.setItem('to-remove', 'value');
    expect(await storage.getItem('to-remove')).toBe('value');

    storage.removeItem('to-remove');
    expect(await storage.getItem('to-remove')).toBeNull();
  });

  it('should return null when decryption fails (wrong passphrase)', async () => {
    const storage1 = await SecureStorage.create('passphrase-1');
    await storage1.setItem('secret', 'hello');

    const storage2 = await SecureStorage.create('passphrase-2');
    const result = await storage2.getItem('secret');

    expect(result).toBeNull();
  });

  it('should handle empty string values', async () => {
    const storage = await SecureStorage.create('test-passphrase');

    await storage.setItem('empty', '');
    const result = await storage.getItem('empty');

    expect(result).toBe('');
  });
});
