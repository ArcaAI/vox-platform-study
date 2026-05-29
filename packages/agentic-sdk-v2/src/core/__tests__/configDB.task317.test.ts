/**
 * TASK-317 W1.3 (AC-2) — configDB v2→v3 upgrade drops the legacy *global*
 * personalization cache row.
 *
 * Personalization is now keyed per `${tenantId}::${userId}` (W1.1), so the old
 * unscoped `arcaai-personalization` row must be removed one-time on upgrade —
 * otherwise a shared workstation could still hydrate the next user from it.
 * The drop is non-destructive to the namespaced rows and to `user-preferences`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ARCAAI_CONFIG_DB_VERSION,
  USER_PREFERENCES_STORE,
  PERSONALIZATION_STORE,
  LEGACY_PERSONALIZATION_GLOBAL_KEY,
  applyConfigDBUpgrade,
} from '../configDB';

function makeMockUpgrade(existingStores: string[]) {
  const created: string[] = [];
  const deletes: Array<{ store: string; key: string }> = [];
  const names = new Set(existingStores);

  const db = {
    objectStoreNames: { contains: (n: string) => names.has(n) },
    createObjectStore: vi.fn((n: string) => {
      names.add(n);
      created.push(n);
    }),
  } as unknown as IDBDatabase;

  const transaction = {
    objectStore: (store: string) => ({
      delete: (key: string) => {
        deletes.push({ store, key });
      },
    }),
  } as unknown as IDBTransaction;

  return { db, transaction, created, deletes };
}

describe('TASK-317 W1.3 — configDB v3 upgrade (AC-2)', () => {
  it('bumps ARCAAI_CONFIG_DB_VERSION to 3', () => {
    expect(ARCAAI_CONFIG_DB_VERSION).toBe(3);
  });

  it('deletes the legacy global personalization row when upgrading from v2', () => {
    const { db, transaction, deletes } = makeMockUpgrade([USER_PREFERENCES_STORE, PERSONALIZATION_STORE]);

    applyConfigDBUpgrade(db, transaction, 2);

    expect(deletes).toContainEqual({ store: PERSONALIZATION_STORE, key: LEGACY_PERSONALIZATION_GLOBAL_KEY });
  });

  it('creates any missing stores on a fresh database while still dropping the legacy row', () => {
    const { db, transaction, created, deletes } = makeMockUpgrade([]);

    applyConfigDBUpgrade(db, transaction, 0);

    expect(created).toContain(USER_PREFERENCES_STORE);
    expect(created).toContain(PERSONALIZATION_STORE);
    expect(deletes).toContainEqual({ store: PERSONALIZATION_STORE, key: LEGACY_PERSONALIZATION_GLOBAL_KEY });
  });

  it('never deletes from the user-preferences store (non-destructive to resolved config)', () => {
    const { db, transaction, deletes } = makeMockUpgrade([USER_PREFERENCES_STORE, PERSONALIZATION_STORE]);

    applyConfigDBUpgrade(db, transaction, 2);

    expect(deletes.every((d) => d.store !== USER_PREFERENCES_STORE)).toBe(true);
  });

  it('does not drop the legacy row when re-opening an already-v3 database', () => {
    const { db, transaction, deletes } = makeMockUpgrade([USER_PREFERENCES_STORE, PERSONALIZATION_STORE]);

    applyConfigDBUpgrade(db, transaction, 3);

    expect(deletes).toHaveLength(0);
  });
});
