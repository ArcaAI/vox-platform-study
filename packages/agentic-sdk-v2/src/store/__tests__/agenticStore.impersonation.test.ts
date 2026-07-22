/**
 * Store no longer holds the admin impersonation token.
 *
 * After this ticket, `authOriginalToken` and `setOriginalToken` no longer
 * exist on the Zustand store. The admin JWT lives only inside `AgenticClient`
 * (via a module-level WeakMap, see `AgenticClient.impersonation.test.ts`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
// Store-logic unit test binds to the module singleton
// directly (the `useAgenticStore` name now refers to the context-backed hook).
import { agenticStoreSingleton as useAgenticStore } from '../agenticStore';

describe('store impersonation token removed', () => {
  it('state object should NOT contain `authOriginalToken` field', () => {
    const state = useAgenticStore.getState() as unknown as Record<string, unknown>;
    expect('authOriginalToken' in state).toBe(false);
  });

  it('store actions object should NOT contain `setOriginalToken`', () => {
    const state = useAgenticStore.getState() as unknown as Record<string, unknown>;
    expect('setOriginalToken' in state).toBe(false);
  });

  it('clearSensitiveData should not throw and should clear only remaining auth fields', () => {
    const state = useAgenticStore.getState();
    expect(() => state.clearSensitiveData()).not.toThrow();
    const after = useAgenticStore.getState() as unknown as Record<string, unknown>;
    expect(after.authUser).toBeNull();
    expect(after.authIsAuthenticated).toBe(false);
    expect(after.authImpersonatedUser).toBeNull();
    expect(after.authOriginalUser).toBeNull();
    expect('authOriginalToken' in after).toBe(false);
  });

  it('clearOnLogout should not throw and should not reference the removed field', () => {
    const state = useAgenticStore.getState();
    // clearOnLogout now takes the outgoing namespace.
    expect(() => state.clearOnLogout('pre-login')).not.toThrow();
  });
});
