/**
 * TASK-304 Wave 2D — PersonalizationManager IndexedDB cache tests
 *
 * Replaces the legacy `localStorage` cache with the shared `arcaai-config`
 * IDB store (separate `personalization` object store). Old `localStorage`
 * data is intentionally ignored (user choice: `ignore-old-data`).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalizationManager } from '../PersonalizationManager';
import { AgenticClient } from '../AgenticClient';
import { createMockLogger } from '../../__tests__/setup';

const idbStore = new Map<string, unknown>();

vi.mock('../configDB', () => ({
  ARCAAI_CONFIG_DB_NAME: 'arcaai-config',
  ARCAAI_CONFIG_DB_VERSION: 2,
  USER_PREFERENCES_STORE: 'user-preferences',
  PERSONALIZATION_STORE: 'personalization',
  openConfigDB: vi.fn(),
  configDBGet: vi.fn(async (_store: string, key: string) => idbStore.get(key)),
  configDBSet: vi.fn(async (_store: string, key: string, value: unknown) => {
    idbStore.set(key, value);
  }),
  configDBDelete: vi.fn(async (_store: string, key: string) => {
    idbStore.delete(key);
  }),
  configDBClear: vi.fn(async () => {
    idbStore.clear();
  }),
}));

describe('PersonalizationManager · IDB cache (Wave 2D)', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    idbStore.clear();
    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'k' }, mockLogger);

    const storageData: Record<string, string> = {
      // Per `ignore-old-data` choice: any leftover localStorage entry must
      // NOT leak into a fresh hydrate.
      'arcaai-preferences': JSON.stringify({ theme: 'dark' }),
    };
    const localStorageMock = {
      getItem: (k: string) => storageData[k] ?? null,
      setItem: (k: string, v: string) => {
        storageData[k] = v;
      },
      removeItem: (k: string) => {
        delete storageData[k];
      },
      clear: () => {
        for (const k of Object.keys(storageData)) delete storageData[k];
      },
      length: 0,
      key: () => null,
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = localStorageMock as unknown as Storage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('hydrate() merges cached preferences from the personalization IDB store', async () => {
    // TASK-317 M-3 — a manager with no namespace fail-closes to `pre-login`,
    // never the bare global key.
    idbStore.set('arcaai-personalization/pre-login', {
      language: 'th',
      localConfig: { stt: { modelId: 'whisper-tiny' } },
    });

    const manager = new PersonalizationManager(
      { storage: 'local', defaults: { language: 'en' } },
      mockApiClient,
      mockLogger
    );

    expect(manager.getPreferences()).toEqual({ language: 'en' });

    await manager.hydrate();

    expect(manager.getPreferences()).toEqual({
      language: 'th',
      localConfig: { stt: { modelId: 'whisper-tiny' } },
    });
  });

  it('hydrate() ignores legacy localStorage data (user choice: ignore-old-data)', async () => {
    const manager = new PersonalizationManager(
      { storage: 'local', defaults: { language: 'en' } },
      mockApiClient,
      mockLogger
    );

    await manager.hydrate();

    expect(manager.getPreferences()).toEqual({ language: 'en' });
    expect(manager.getPreferences()).not.toHaveProperty('theme');
  });

  it('updatePreferences() writes the merged snapshot to the personalization IDB store', async () => {
    const manager = new PersonalizationManager(
      { storage: 'local', defaults: { language: 'en' } },
      mockApiClient,
      mockLogger
    );
    await manager.hydrate();

    await manager.updatePreferences({ language: 'th' });

    expect(idbStore.get('arcaai-personalization/pre-login')).toEqual({ language: 'th' });
  });

  it('hydrate() recovers from IDB read failures by keeping the in-memory defaults', async () => {
    const cfgDB = await import('../configDB.js');
    vi.mocked(cfgDB.configDBGet).mockRejectedValueOnce(new Error('IDB closed'));

    const manager = new PersonalizationManager(
      { storage: 'local', defaults: { language: 'en' } },
      mockApiClient,
      mockLogger
    );

    await expect(manager.hydrate()).resolves.toBeUndefined();
    expect(manager.getPreferences()).toEqual({ language: 'en' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to hydrate preferences from cache',
      expect.objectContaining({ component: 'PersonalizationManager' })
    );
  });

  it('updatePreferences() does NOT throw when the IDB write fails (best-effort cache)', async () => {
    const cfgDB = await import('../configDB.js');
    vi.mocked(cfgDB.configDBSet).mockRejectedValueOnce(new Error('quota exceeded'));

    const manager = new PersonalizationManager(
      { storage: 'local', defaults: { language: 'en' } },
      mockApiClient,
      mockLogger
    );
    await manager.hydrate();

    await expect(manager.updatePreferences({ language: 'th' })).resolves.toBeUndefined();
    expect(manager.getPreferences()).toEqual({ language: 'th' });
  });
});
