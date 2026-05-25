/**
 * @arcaai/vox - Shared IndexedDB helpers for the `arcaai-config` database.
 *
 * TASK-304 Wave 2 W2-PM-1
 *
 * Two distinct call sites used to open `arcaai-config` directly:
 *   • {@link AgenticProvider}'s `openConfigDB` (v1, single `user-preferences` store)
 *   • {@link agenticStore.clearOnLogout} (open-only, schema-tolerant)
 *
 * We are now adding a third writer — {@link PersonalizationManager} — to
 * cache its preferences in IDB instead of `localStorage`. Letting each
 * writer open the DB at a different version triggers `VersionError` in
 * real browsers, so this module owns the schema for ALL writers:
 *
 *   • `user-preferences`     — ConfigManager-resolved DeepPartial<AppConfig>
 *   • `personalization`      — PersonalizationManager's UserPreferences cache
 *
 * The version bumps to 2 to add the new `personalization` store; any
 * existing browser that already opened v1 will run `onupgradeneeded`
 * exactly once to add the new store while keeping its `user-preferences`
 * contents intact.
 */

export const ARCAAI_CONFIG_DB_NAME = 'arcaai-config' as const;
export const ARCAAI_CONFIG_DB_VERSION = 2 as const;

export const USER_PREFERENCES_STORE = 'user-preferences' as const;
export const PERSONALIZATION_STORE = 'personalization' as const;

export type ConfigDBStore = typeof USER_PREFERENCES_STORE | typeof PERSONALIZATION_STORE;

/**
 * Open the shared `arcaai-config` database. Creates any missing store
 * during `onupgradeneeded`, so opening from an older v1 browser only
 * adds the new `personalization` store without rebuilding the existing
 * `user-preferences` data.
 */
export function openConfigDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment'));
      return;
    }
    const request = indexedDB.open(ARCAAI_CONFIG_DB_NAME, ARCAAI_CONFIG_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(USER_PREFERENCES_STORE)) {
        db.createObjectStore(USER_PREFERENCES_STORE);
      }
      if (!db.objectStoreNames.contains(PERSONALIZATION_STORE)) {
        db.createObjectStore(PERSONALIZATION_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another connection'));
  });
}

/** Read a single record from the requested store. */
export async function configDBGet<T>(store: ConfigDBStore, key: string): Promise<T | undefined> {
  const db = await openConfigDB();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Write a single record to the requested store. */
export async function configDBSet(store: ConfigDBStore, key: string, value: unknown): Promise<void> {
  const db = await openConfigDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Delete a single record from the requested store. */
export async function configDBDelete(store: ConfigDBStore, key: string): Promise<void> {
  const db = await openConfigDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Clear the entire contents of the requested store. */
export async function configDBClear(store: ConfigDBStore): Promise<void> {
  const db = await openConfigDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}
