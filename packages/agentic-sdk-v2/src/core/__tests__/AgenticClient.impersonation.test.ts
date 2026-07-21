/**
 * AgenticClient impersonation token (PHI-safe storage)
 *
 * The admin JWT held during an impersonation session previously lived in the
 * Zustand store as `authOriginalToken`, exposed through `useAgenticStore.getState()`.
 * This is a security defect: any third-party code in the same
 * JS context could read the raw admin token.
 *
 * This test suite enforces that:
 *   1. AgenticClient exposes `startImpersonation(token)`, `stopImpersonation()`,
 *      `isImpersonating()`.
 *   2. The held original token is NOT enumerable on the client object — it must
 *      not show up in `Object.keys`, `JSON.stringify`, structured-clone, or
 *      `Object.getOwnPropertyNames` (with public access).
 *   3. `stopImpersonation()` returns the original token exactly once, then
 *      clears it so a subsequent call returns `undefined`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { createMockLogger } from '../../__tests__/setup';

describe('TASK-264 W0-3: AgenticClient impersonation', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient(
      { baseUrl: 'https://api.example.com' },
      mockLogger,
    );
  });

  describe('startImpersonation / stopImpersonation / isImpersonating', () => {
    it('should report isImpersonating() === false on a fresh client', () => {
      expect(client.isImpersonating()).toBe(false);
    });

    it('should report isImpersonating() === true after startImpersonation', () => {
      client.startImpersonation('admin-jwt-token');
      expect(client.isImpersonating()).toBe(true);
    });

    it('should report isImpersonating() === false after stopImpersonation', () => {
      client.startImpersonation('admin-jwt-token');
      client.stopImpersonation();
      expect(client.isImpersonating()).toBe(false);
    });

    it('stopImpersonation should return the original token exactly once', () => {
      client.startImpersonation('admin-jwt-token');
      expect(client.stopImpersonation()).toBe('admin-jwt-token');
      expect(client.stopImpersonation()).toBeUndefined();
    });

    it('stopImpersonation on a fresh client should return undefined and not throw', () => {
      expect(() => client.stopImpersonation()).not.toThrow();
      expect(client.stopImpersonation()).toBeUndefined();
    });

    it('startImpersonation with an empty string should throw (defensive)', () => {
      expect(() => client.startImpersonation('')).toThrow(/non-empty/i);
      expect(client.isImpersonating()).toBe(false);
    });

    it('calling startImpersonation twice without stop should be rejected (avoid lose-prior-token bug)', () => {
      client.startImpersonation('first-token');
      expect(() => client.startImpersonation('second-token')).toThrow(/already/i);
      // First token still recoverable
      expect(client.stopImpersonation()).toBe('first-token');
    });
  });

  describe('original token never leaks (SEC-4)', () => {
    it('should NOT appear in Object.keys()', () => {
      client.startImpersonation('SECRET-ADMIN-TOKEN');
      const keys = Object.keys(client);
      expect(keys.join('|')).not.toContain('SECRET-ADMIN-TOKEN');
      expect(keys).not.toContain('impersonationOriginalToken');
      expect(keys).not.toContain('authOriginalToken');
      expect(keys).not.toContain('originalToken');
    });

    it('should NOT appear in JSON.stringify(client)', () => {
      client.startImpersonation('SECRET-ADMIN-TOKEN');
      const serialised = JSON.stringify(client);
      expect(serialised).not.toContain('SECRET-ADMIN-TOKEN');
    });

    it('should NOT be enumerable via Object.getOwnPropertyNames + JSON.stringify of each value', () => {
      client.startImpersonation('SECRET-ADMIN-TOKEN');
      const names = Object.getOwnPropertyNames(client);
      for (const name of names) {
        const value = (client as unknown as Record<string, unknown>)[name];
        if (typeof value === 'string') {
          expect(value).not.toBe('SECRET-ADMIN-TOKEN');
        }
      }
    });
  });
});
