/**
 * TASK-329 X10 — summarization history must be namespaced per tenant + user.
 *
 * Bug: the generation history used a single global localStorage key
 * (`arcaai-summarization-history`). An admin impersonating Dr. A, then Dr. B,
 * (or switching tenants) saw — and appended to — the same shared history,
 * leaking one doctor's generations into another's view.
 *
 * Fix: key history by `${tenantId}::${effectiveUserId}` (the impersonated
 * user when impersonating). These tests assert isolation across scopes and
 * that the legacy global key is never written.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/auth-store';
import { addToHistory, loadHistory, historyStorageKey } from '../index';

const TENANT_A = '50000000-0000-0000-0000-00000000000a';
const TENANT_B = '50000000-0000-0000-0000-00000000000b';

const ADMIN_USER = { id: 'admin-1', email: 'admin@test.com', username: 'admin', roles: ['GLOBAL_ADMIN'], permissions: [] };
const DOCTOR_A = { id: 'doctor-a', email: 'a@test.com', username: 'doc_a', roles: ['DOCTOR'], permissions: [] };
const DOCTOR_B = { id: 'doctor-b', email: 'b@test.com', username: 'doc_b', roles: ['DOCTOR'], permissions: [] };

function entry(id: string) {
  return {
    id,
    type: 'summary' as const,
    content: `content-${id}`,
    provider: 'ollama',
    model: 'llama3',
    processingTimeMs: 100,
    tokenUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
});

describe('TASK-329 X10 — summarization history localStorage namespacing', () => {
  it('namespaces the key by tenant + effective user', () => {
    useAuthStore.getState().setCredentialsAuth('tok', DOCTOR_A, TENANT_A);
    expect(historyStorageKey()).toBe(`arcaai-summarization-history::${TENANT_A}::${DOCTOR_A.id}`);
  });

  it('uses the IMPERSONATED user id while impersonating, not the admin', () => {
    useAuthStore.getState().setCredentialsAuth('tok', ADMIN_USER, TENANT_A);
    useAuthStore.getState().startImpersonation(DOCTOR_A, 'imp-tok');
    expect(historyStorageKey()).toBe(`arcaai-summarization-history::${TENANT_A}::${DOCTOR_A.id}`);
  });

  it('never writes to the legacy global key', () => {
    useAuthStore.getState().setCredentialsAuth('tok', DOCTOR_A, TENANT_A);
    addToHistory(entry('1'));
    expect(localStorage.getItem('arcaai-summarization-history')).toBeNull();
    expect(localStorage.getItem(`arcaai-summarization-history::${TENANT_A}::${DOCTOR_A.id}`)).not.toBeNull();
  });

  it('does not leak history across impersonated doctors in the same tenant', () => {
    useAuthStore.getState().setCredentialsAuth('tok', ADMIN_USER, TENANT_A);

    useAuthStore.getState().startImpersonation(DOCTOR_A, 'imp-a');
    addToHistory(entry('a1'));
    expect(loadHistory().map((h) => h.id)).toEqual(['a1']);

    // Switch to impersonating a different doctor — must start empty.
    useAuthStore.getState().endImpersonation();
    useAuthStore.getState().startImpersonation(DOCTOR_B, 'imp-b');
    expect(loadHistory()).toEqual([]);

    addToHistory(entry('b1'));
    expect(loadHistory().map((h) => h.id)).toEqual(['b1']);

    // Back to Dr. A — original entry is still isolated and intact.
    useAuthStore.getState().endImpersonation();
    useAuthStore.getState().startImpersonation(DOCTOR_A, 'imp-a2');
    expect(loadHistory().map((h) => h.id)).toEqual(['a1']);
  });

  it('does not leak history across tenants for the same user', () => {
    useAuthStore.getState().setCredentialsAuth('tok', DOCTOR_A, TENANT_A);
    addToHistory(entry('ta'));
    expect(loadHistory().map((h) => h.id)).toEqual(['ta']);

    useAuthStore.getState().setTenant(TENANT_B);
    expect(loadHistory()).toEqual([]);
  });
});
