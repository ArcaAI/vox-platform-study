/**
 * @arcaai/vox - E2E Tests
 *
 * End-to-end tests for the SDK including provider, hooks, store, and utilities.
 */

import { test, expect, type Page } from '@playwright/test';

test.describe('@arcaai/vox E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for SDK to load
    await page.waitForFunction(() => window.SDK !== undefined);
  });

  test.describe('Module Loading', () => {
    test('should load all SDK exports', async ({ page }) => {
      const exports = await page.evaluate(() => window.sdkExports);

      expect(exports.AgenticProvider).toBe(true);
      expect(exports.useAgenticContext).toBe(true);
      expect(exports.useArca).toBe(true);
      expect(exports.useArcaConfig).toBe(true);
      expect(exports.useArcaSession).toBe(true);
      expect(exports.useAgenticStore).toBe(true);
      expect(exports.AgenticClient).toBe(true);
      expect(exports.PluginManager).toBe(true);
      expect(exports.PersonalizationManager).toBe(true);
      expect(exports.ModelRegistry).toBe(true);
      expect(exports.StreamingSessionManager).toBe(true);
      expect(exports.SttWebSocketClient).toBe(true);
    });

    test('should load pipeline exports', async ({ page }) => {
      const exports = await page.evaluate(() => window.sdkExports);

      expect(exports.TranscriptionPipeline).toBe(true);
      expect(exports.KnowledgePipeline).toBe(true);
    });

    test('should load logger exports', async ({ page }) => {
      const exports = await page.evaluate(() => window.sdkExports);

      expect(exports.SDKLogger).toBe(true);
      expect(exports.ConsoleTransport).toBe(true);
    });

    test('should load utility exports', async ({ page }) => {
      const exports = await page.evaluate(() => window.sdkExports);

      expect(exports.formatDate).toBe(true);
      expect(exports.formatRelativeTime).toBe(true);
      expect(exports.isAgenticError).toBe(true);
      expect(exports.wrapError).toBe(true);
      expect(exports.AgenticError).toBe(true);
    });

    test('should load constants', async ({ page }) => {
      const exports = await page.evaluate(() => window.sdkExports);

      expect(exports.CONSULTATION_ENDPOINTS).toBe(true);
      expect(exports.CONTEXT_ENDPOINTS).toBe(true);
      expect(exports.SUMMARY_ENDPOINTS).toBe(true);
    });
  });

  test.describe('SDK Constants', () => {
    // The endpoint maps are read INSIDE the page rather than off the serialized
    // `window.sdkConstants` snapshot: `page.evaluate` returns JSON, which drops
    // every function-valued endpoint builder, so a snapshot read reports
    // `undefined` for entries that are perfectly healthy.
    test('should have CONSULTATION_ENDPOINTS', async ({ page }) => {
      const endpoints = await page.evaluate(() => ({
        open: window.SDK.CONSULTATION_ENDPOINTS.OPEN,
        get: typeof window.SDK.CONSULTATION_ENDPOINTS.GET,
        close: typeof window.SDK.CONSULTATION_ENDPOINTS.CLOSE,
      }));

      // `CREATE`/`END` are gone: opening is get-or-create (`session.open()`), and
      // a consultation is CLOSEd/REOPENed rather than ended.
      expect(endpoints.open).toBe('/consultations/open');
      expect(endpoints.get).toBe('function');
      expect(endpoints.close).toBe('function');
    });

    test('should have CONTEXT_ENDPOINTS', async ({ page }) => {
      const endpoints = await page.evaluate(() => ({
        add: typeof window.SDK.CONTEXT_ENDPOINTS.ADD,
        get: typeof window.SDK.CONTEXT_ENDPOINTS.GET,
        update: typeof window.SDK.CONTEXT_ENDPOINTS.UPDATE,
      }));

      expect(endpoints.add).toBe('function');
      expect(endpoints.get).toBe('function');
      expect(endpoints.update).toBe('function');
    });

    test('should have DEFAULT_TIMEOUT', async ({ page }) => {
      const constants = await page.evaluate(() => window.sdkConstants);

      expect(constants.DEFAULT_TIMEOUT).toBe(30000);
    });

    test('should have STORAGE_KEYS', async ({ page }) => {
      const constants = await page.evaluate(() => window.sdkConstants);

      // `PREFERENCES` and `SESSION_STATE` were removed as dead keys (no live
      // writer); their assertions are dropped here so this suite carries no
      // dangling reference. The unit suite (constants.test.ts) asserts both
      // keys are absent from STORAGE_KEYS.
      expect(constants.STORAGE_KEYS.SELECTED_MODELS).toBe('arcaai-selected-models');
    });
  });

  test.describe('AgenticProvider', () => {
    test('should mount provider successfully', async ({ page }) => {
      await page.click('#btn-mount-provider');

      // Check that provider is mounted
      await expect(page.locator('#react-root')).toHaveClass(/mounted/);
      await expect(page.locator('#react-root')).toContainText('AgenticProvider Mounted');

      const isMounted = await page.evaluate(() => window.reactMounted);
      expect(isMounted).toBe(true);
    });

    test('should unmount provider successfully', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await expect(page.locator('#react-root')).toHaveClass(/mounted/);

      await page.click('#btn-unmount-provider');

      await expect(page.locator('#react-root')).not.toHaveClass(/mounted/);

      const isMounted = await page.evaluate(() => window.reactMounted);
      expect(isMounted).toBe(false);
    });

    test('should apply configuration', async ({ page }) => {
      // Set custom configuration
      await page.fill('#config-base-url', 'http://custom-api.example.com');
      await page.fill('#config-tenant-id', 'custom-tenant-123');
      await page.selectOption('#config-personalization', 'hybrid');

      await page.click('#btn-mount-provider');

      // Check configuration was applied
      await expect(page.locator('#config-status')).toContainText('custom-api.example.com');
      await expect(page.locator('#config-status')).toContainText('custom-tenant-123');
      await expect(page.locator('#config-status')).toContainText('hybrid');
    });

    test('should display configuration in mounted component', async ({ page }) => {
      await page.fill('#config-base-url', 'http://test-api.com');
      await page.fill('#config-tenant-id', 'test-tenant');

      await page.click('#btn-mount-provider');

      await expect(page.locator('#react-root')).toContainText('Base URL: http://test-api.com');
      await expect(page.locator('#react-root')).toContainText('Tenant: test-tenant');
    });
  });

  test.describe('Zustand Store', () => {
    test('should show store state after mounting', async ({ page }) => {
      await page.click('#btn-mount-provider');

      // Wait for store to initialize
      await page.waitForTimeout(200);

      // Click refresh to ensure UI is updated
      await page.click('#btn-refresh-store');

      // Check store values are displayed
      await expect(page.locator('#store-initialized')).not.toHaveText('-');
    });

    test('should update store state on refresh', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.waitForTimeout(200);

      const initialValue = await page.locator('#store-context').textContent();

      await page.click('#btn-refresh-store');

      // Values should be populated (0 is valid)
      await expect(page.locator('#store-context')).toHaveText(/\d+/);
    });
  });

  // The "Lifecycle Management" describe block was removed along with the fixture
  // panel it drove: `LifecycleManager`, `SessionCoordinator` and
  // `SessionPersistence` are no longer exported and the store has no `lifecycle`
  // slice, so its three tests asserted a subsystem that no longer exists (two of
  // them passed only because they matched the panel's static placeholder text).
  // Session close/reopen is covered through `useArcaSession()`.

  test.describe('Date Utilities', () => {
    test('should format date correctly', async ({ page }) => {
      // Set a specific date
      await page.fill('#utils-date-input', '2026-01-27T15:30');
      await page.click('#btn-format-date');

      await expect(page.locator('#utils-output')).toContainText('2026-01-27');

      const result = await page.evaluate(() => window.dateFormatResult);
      expect(result).toBe('2026-01-27');
    });

    test('should format relative time correctly', async ({ page }) => {
      // Set a date from a few minutes ago. `#utils-date-input` is a
      // `datetime-local` field, so the value must be LOCAL time — feeding it
      // `toISOString()` (UTC) shifts the instant by the runner's UTC offset and
      // turns "5 minutes ago" into "N hours ago" everywhere but UTC.
      const now = new Date();
      now.setMinutes(now.getMinutes() - 5);
      const pad = (n: number) => String(n).padStart(2, '0');
      const isoString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

      await page.fill('#utils-date-input', isoString);
      await page.click('#btn-format-relative');

      await expect(page.locator('#utils-output')).toContainText('formatRelativeTime');

      const result = await page.evaluate(() => window.relativeFormatResult);
      expect(result).toContain('minute');
    });
  });

  test.describe('Error Utilities', () => {
    test('should create AgenticError', async ({ page }) => {
      await page.selectOption('#utils-error-code', 'NETWORK_ERROR');
      await page.click('#btn-create-error');

      await expect(page.locator('#error-output')).toContainText('Code: NETWORK_ERROR');
      await expect(page.locator('#error-output')).toContainText('Is AgenticError: true');

      const error = await page.evaluate(() => ({
        code: window.testError?.code,
        isError: window.testError instanceof Error,
      }));

      expect(error.code).toBe('NETWORK_ERROR');
      expect(error.isError).toBe(true);
    });

    test('should check if error is retriable', async ({ page }) => {
      await page.selectOption('#utils-error-code', 'NETWORK_ERROR');
      await page.click('#btn-check-retriable');

      await expect(page.locator('#error-output')).toContainText('Is Retriable: Yes');

      const isRetriable = await page.evaluate(() => window.retriableResult);
      expect(isRetriable).toBe(true);
    });

    test('should identify non-retriable errors', async ({ page }) => {
      await page.selectOption('#utils-error-code', 'AUTHENTICATION_ERROR');
      await page.click('#btn-check-retriable');

      await expect(page.locator('#error-output')).toContainText('Is Retriable: No');
      await expect(page.locator('#error-output')).toContainText('Is Auth Error: Yes');

      const isRetriable = await page.evaluate(() => window.retriableResult);
      expect(isRetriable).toBe(false);
    });

    test('should identify network errors', async ({ page }) => {
      await page.selectOption('#utils-error-code', 'NETWORK_ERROR');
      await page.click('#btn-check-retriable');

      await expect(page.locator('#error-output')).toContainText('Is Network Error: Yes');
    });
  });

  test.describe('Logger', () => {
    test('should log messages after mounting', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.waitForTimeout(200);

      // Log different levels
      await page.click('#btn-log-info');

      await expect(page.locator('#logger-output')).toContainText('Info message from E2E test');
    });

    test('should log warning messages', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.waitForTimeout(200);

      await page.click('#btn-log-warn');

      await expect(page.locator('#logger-output')).toContainText('Warning message from E2E test');
    });

    test('should log error messages', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.waitForTimeout(200);

      await page.click('#btn-log-error');

      await expect(page.locator('#logger-output')).toContainText('Error message from E2E test');
    });

    test('should clear logs', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.waitForTimeout(200);

      await page.click('#btn-log-info');
      await page.click('#btn-log-warn');

      await page.click('#btn-clear-logs');

      await expect(page.locator('#logger-output')).toBeEmpty();
    });
  });

  test.describe('Type Exports', () => {
    test('should export AgenticError class', async ({ page }) => {
      const types = await page.evaluate(() => window.sdkTypes);

      expect(types.hasAgenticError).toBe(true);
    });

    test('should export plugin default configs', async ({ page }) => {
      const types = await page.evaluate(() => window.sdkTypes);

      // NOTE: `DEFAULT_AUDIO_STATE`/`DEFAULT_AUDIO_PLUGIN_STATES` are defined in
      // `src/types/audio.ts` but never re-exported by the root barrel, so they
      // are not reachable by a consumer and are not asserted here.
      expect(types.hasDefaultSttConfig).toBe(true);
      expect(types.hasDefaultVadConfig).toBe(true);
      expect(types.hasDefaultNoiseFilterConfig).toBe(true);
    });
  });

  test.describe('Event Logging', () => {
    test('should log SDK load event', async ({ page }) => {
      await expect(page.locator('#events-list')).toContainText('SDK ready for testing');
    });

    test('should log provider mount event', async ({ page }) => {
      await page.click('#btn-mount-provider');

      await expect(page.locator('#events-list')).toContainText('AgenticProvider mounted successfully');
    });

    test('should log provider unmount event', async ({ page }) => {
      await page.click('#btn-mount-provider');
      await page.click('#btn-unmount-provider');

      await expect(page.locator('#events-list')).toContainText('AgenticProvider unmounted');
    });

    test('should clear events', async ({ page }) => {
      await page.click('#btn-mount-provider');

      await page.click('#btn-clear-events');

      await expect(page.locator('#events-list')).toBeEmpty();
    });
  });

  test.describe('Cross-Browser Compatibility', () => {
    test('should work in current browser', async ({ page, browserName }) => {
      // Module loading
      const exports = await page.evaluate(() => window.sdkExports);
      expect(exports.AgenticProvider).toBe(true);

      // Provider mounting
      await page.click('#btn-mount-provider');
      await expect(page.locator('#react-root')).toHaveClass(/mounted/);

      // Utilities
      await page.fill('#utils-date-input', '2026-01-27T12:00');
      await page.click('#btn-format-date');
      const result = await page.evaluate(() => window.dateFormatResult);
      expect(result).toBe('2026-01-27');

      console.log(`Test passed in ${browserName}`);
    });
  });

  test.describe('SDK Integration', () => {
    test('should have all core classes instantiable', async ({ page }) => {
      const canInstantiate = await page.evaluate(() => {
        const { SDK } = window;
        try {
          // Test AgenticClient
          const client = new SDK.AgenticClient({
            baseUrl: 'http://test.com',
            tenantId: 'test',
          });

          // Test PersonalizationManager - needs a client
          const personalization = new SDK.PersonalizationManager(client, {
            storage: 'local',
          });

          // Test ModelRegistry
          const models = new SDK.ModelRegistry(client);

          return {
            client: client !== null,
            personalization: personalization !== null,
            models: models !== null,
          };
        } catch (e) {
          return { error: e.message };
        }
      });

      expect(canInstantiate.error).toBeUndefined();
      expect(canInstantiate.client).toBe(true);
      expect(canInstantiate.personalization).toBe(true);
      expect(canInstantiate.models).toBe(true);
    });

    test('should have correct endpoint generators', async ({ page }) => {
      const endpoints = await page.evaluate(() => {
        const { SDK } = window;
        return {
          getConsultation: SDK.CONSULTATION_ENDPOINTS.GET('test-123'),
          closeConsultation: SDK.CONSULTATION_ENDPOINTS.CLOSE('test-123'),
          addContext: SDK.CONTEXT_ENDPOINTS.ADD('test-123'),
          updateContext: SDK.CONTEXT_ENDPOINTS.UPDATE('test-123', 'item-456'),
        };
      });

      expect(endpoints.getConsultation).toBe('/consultations/test-123');
      expect(endpoints.closeConsultation).toBe('/consultations/test-123/close');
      expect(endpoints.addContext).toBe('/consultations/test-123/context');
      expect(endpoints.updateContext).toBe('/consultations/test-123/context/item-456');
    });
  });

  test.describe('Store Selectors', () => {
    // Only selectors the ROOT barrel re-exports are asserted. The bulk of
    // `select*` (selectTranscriptions, selectCaseNotes, …) lives on
    // `src/store/agenticStore.ts` and is consumed through `useArcaStore(selector)`
    // inside a provider — never off the SDK namespace.
    test('should have selector functions', async ({ page }) => {
      const hasSelectors = await page.evaluate(() => {
        const { SDK } = window;
        return {
          useArcaStore: typeof SDK.useArcaStore === 'function',
          selectAudioDropped: typeof SDK.selectAudioDropped === 'function',
          selectAudioDegraded: typeof SDK.selectAudioDegraded === 'function',
        };
      });

      expect(hasSelectors.useArcaStore).toBe(true);
      expect(hasSelectors.selectAudioDropped).toBe(true);
      expect(hasSelectors.selectAudioDegraded).toBe(true);
    });
  });
});
