/**
 * TASK-317 W1.1 (AC-1) — PersonalizationManager per-(tenant,user) IDB namespacing
 *
 * Closes audit finding C-3: the personalization cache row used to be a single
 * global `arcaai-personalization` key, so a shared workstation hydrated the
 * next user from the previous user's voice-profile / model ids.
 *
 * The cache key is now `arcaai-personalization/${tenantId}::${userId}` (the same
 * `ns` AgenticProvider already builds for `USER_PREFERENCES_STORE`).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalizationManager, personalizationCacheKey } from '../PersonalizationManager';
import { AgenticClient } from '../AgenticClient';
import { createMockLogger } from '../../__tests__/setup';

const idbStore = new Map<string, unknown>();

vi.mock('../configDB', () => ({
  ARCAAI_CONFIG_DB_NAME: 'arcaai-config',
  ARCAAI_CONFIG_DB_VERSION: 3,
  USER_PREFERENCES_STORE: 'user-preferences',
  PERSONALIZATION_STORE: 'personalization',
  LEGACY_PERSONALIZATION_GLOBAL_KEY: 'arcaai-personalization',
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

const NS_A = 'tenantA::userA';
const NS_B = 'tenantB::userB';

describe('TASK-317 W1.1 — PersonalizationManager IDB namespacing (AC-1)', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    idbStore.clear();
    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'k' }, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the cache key as `arcaai-personalization/${namespace}`', () => {
    expect(personalizationCacheKey(NS_A)).toBe('arcaai-personalization/tenantA::userA');
    expect(personalizationCacheKey(NS_B)).toBe('arcaai-personalization/tenantB::userB');
  });

  it('writes two namespaces to two distinct IDB rows and never to the legacy global key', async () => {
    const a = new PersonalizationManager({ storage: 'local', defaults: {} }, mockApiClient, mockLogger, NS_A);
    const b = new PersonalizationManager({ storage: 'local', defaults: {} }, mockApiClient, mockLogger, NS_B);

    await a.updatePreferences({ language: 'en' });
    await b.updatePreferences({ language: 'th' });

    expect(idbStore.get('arcaai-personalization/tenantA::userA')).toEqual({ language: 'en' });
    expect(idbStore.get('arcaai-personalization/tenantB::userB')).toEqual({ language: 'th' });
    // The unscoped global key (C-3) must never be written again.
    expect(idbStore.has('arcaai-personalization')).toBe(false);
  });

  it('does not cross-read another namespace on hydrate', async () => {
    idbStore.set('arcaai-personalization/tenantA::userA', { language: 'en', dnaStyleId: 'styleA' });
    idbStore.set('arcaai-personalization/tenantB::userB', { language: 'th', dnaStyleId: 'styleB' });

    const a = new PersonalizationManager({ storage: 'local', defaults: {} }, mockApiClient, mockLogger, NS_A);
    await a.hydrate();
    expect(a.getPreferences()).toEqual({ language: 'en', dnaStyleId: 'styleA' });

    const b = new PersonalizationManager({ storage: 'local', defaults: {} }, mockApiClient, mockLogger, NS_B);
    await b.hydrate();
    expect(b.getPreferences()).toEqual({ language: 'th', dnaStyleId: 'styleB' });
  });
});
