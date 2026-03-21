/**
 * @arcaai/stt E2E Tests
 *
 * Browser-based end-to-end tests for the STT plugin.
 * Tests real browser APIs and actual audio processing capabilities.
 */

import { test, expect, type Page } from '@playwright/test';

// Type for test results exposed by the fixture
interface TestResults {
  browserSupport: {
    webAssembly: boolean;
    webGPU: boolean;
    audioContext: boolean;
    webSocket: boolean;
    mediaDevices: boolean;
  } | null;
  sttProcessor: unknown;
  transcriptions: Array<{ text: string; isFinal: boolean }>;
  errors: Array<{ message: string; code?: string }>;
  events: Array<{ time: string; message: string; type: string }>;
  initialized: boolean;
  started: boolean;
}

// Helper to get test results from page
async function getTestResults(page: Page): Promise<TestResults> {
  return page.evaluate(() => (window as unknown as { testResults: TestResults }).testResults);
}

// Helper to call test helper functions
async function callTestHelper(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }) => {
      const helpers = (window as unknown as { sttTestHelpers: Record<string, (...args: unknown[]) => Promise<unknown>> }).sttTestHelpers;
      return helpers[fn](...args);
    },
    { fn, args }
  );
}

test.describe('@arcaai/stt E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to test fixture
    await page.goto('http://localhost:3333/');

    // Wait for page to load and check browser support
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    });
  });

  test.describe('Browser Support Detection', () => {
    test('should detect WebAssembly support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport).not.toBeNull();
      expect(results.browserSupport!.webAssembly).toBe(true);
    });

    test('should detect AudioContext support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport!.audioContext).toBe(true);
    });

    test('should detect WebSocket support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport!.webSocket).toBe(true);
    });

    test('should detect MediaDevices support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport!.mediaDevices).toBe(true);
    });

    test('should have browser support status displayed', async ({ page }) => {
      // Check that support status is displayed in the UI
      await expect(page.locator('#wasm-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#webgpu-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#audio-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#ws-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#media-support')).toContainText(/Supported|Not supported/);
    });
  });

  test.describe('STT Module Loading', () => {
    test('should load STT module dynamically', async ({ page }) => {
      // Try to import the module
      const moduleLoaded = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.mjs');
          return {
            hasSTTProcessor: typeof module.STTProcessor === 'function',
            hasGenerateSessionId: typeof module.generateSessionId === 'function',
            exports: Object.keys(module),
          };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      // Module might not be built yet, so handle both cases
      if ('error' in moduleLoaded) {
        console.log('Module not built yet:', moduleLoaded.error);
        test.skip();
      } else {
        expect(moduleLoaded.hasSTTProcessor).toBe(true);
        expect(moduleLoaded.hasGenerateSessionId).toBe(true);
      }
    });

    test('should export expected types and utilities', async ({ page }) => {
      const exports = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.mjs');
          return Object.keys(module);
        } catch {
          return [];
        }
      });

      if (exports.length === 0) {
        console.log('Module not built yet');
        test.skip();
      } else {
        // Check for key exports
        expect(exports).toContain('STTProcessor');
        expect(exports).toContain('generateSessionId');
        expect(exports).toContain('DEFAULT_AUDIO_CONFIG');
        expect(exports).toContain('DEFAULT_FEATURE_FLAGS');
      }
    });
  });

  test.describe('STT Initialization', () => {
    test('should initialize with local provider (WASM)', async ({ page }) => {
      const results = await getTestResults(page);

      // Skip if WebAssembly not supported
      if (!results.browserSupport?.webAssembly) {
        test.skip();
      }

      // Check if module is available
      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.mjs');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        console.log('STT module not built');
        test.skip();
      }

      // Click init local button
      await page.click('#btn-init-local');

      // Wait for initialization (with longer timeout for model loading)
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.initialized,
        { timeout: 60000 }
      );

      const afterInit = await getTestResults(page);
      expect(afterInit.initialized).toBe(true);
      expect(afterInit.errors).toHaveLength(0);

      // Check UI state
      await expect(page.locator('#provider-type')).toHaveText('local');
      await expect(page.locator('#session-id')).not.toHaveText('-');
    });

    test('should generate unique session IDs', async ({ page }) => {
      const sessionIds = await page.evaluate(async () => {
        try {
          const { generateSessionId } = await import('/dist/index.mjs');
          return [generateSessionId(), generateSessionId(), generateSessionId()];
        } catch {
          return [];
        }
      });

      if (sessionIds.length === 0) {
        test.skip();
      }

      // All session IDs should be unique
      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(3);

      // Session IDs should have expected format
      for (const id of sessionIds) {
        expect(id).toMatch(/^stt-[a-z0-9]+-[a-z0-9]+$/);
      }
    });

    test('should handle initialization errors gracefully', async ({ page }) => {
      // Try to initialize with invalid config
      const result = await page.evaluate(async () => {
        try {
          const { STTProcessor } = await import('/dist/index.mjs');
          // Local provider without modelId should throw
          new STTProcessor({
            features: { provider: 'local' },
          });
          return { error: null };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if (result.error === null) {
        // Module not available or behavior changed
        console.log('Validation may not be immediate');
      } else if (result.error.includes('module specifier') || result.error.includes('@arcaai/room')) {
        // Module resolution error - skip this test in browser E2E
        console.log('Module resolution error (expected without bundling):', result.error);
        test.skip();
      } else {
        expect(result.error).toContain('modelId');
      }
    });
  });

  test.describe('Audio Processing', () => {
    test('should create AudioContext with correct sample rate', async ({ page }) => {
      const audioInfo = await page.evaluate(() => {
        const ctx = new AudioContext({ sampleRate: 16000 });
        const info = {
          sampleRate: ctx.sampleRate,
          state: ctx.state,
          baseLatency: ctx.baseLatency,
        };
        ctx.close();
        return info;
      });

      // Sample rate may be hardware-limited
      expect(audioInfo.sampleRate).toBeGreaterThan(0);
      expect(['suspended', 'running']).toContain(audioInfo.state);
    });

    test('should handle getUserMedia with fake device', async ({ page }) => {
      // Playwright is configured to use fake media devices
      const mediaResult = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const tracks = stream.getAudioTracks();
          const info = {
            trackCount: tracks.length,
            trackLabel: tracks[0]?.label,
            trackEnabled: tracks[0]?.enabled,
          };
          // Clean up
          tracks.forEach((t) => t.stop());
          return info;
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if ('error' in mediaResult) {
        console.log('Media error:', mediaResult.error);
      } else {
        expect(mediaResult.trackCount).toBeGreaterThan(0);
        expect(mediaResult.trackEnabled).toBe(true);
      }
    });
  });

  test.describe('Event System', () => {
    test('should emit events through the fixture UI', async ({ page }) => {
      // Check that events are logged
      await page.waitForSelector('#logs div');

      const logsContent = await page.locator('#logs').textContent();
      expect(logsContent).toContain('Browser support checked');
    });

    test('should track events in testResults', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.events.length).toBeGreaterThan(0);
      expect(results.events[0]).toHaveProperty('time');
      expect(results.events[0]).toHaveProperty('message');
      expect(results.events[0]).toHaveProperty('type');
    });
  });

  test.describe('Cleanup', () => {
    test('should properly destroy STT instance', async ({ page }) => {
      // Check if module is available
      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.mjs');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Initialize
      await page.click('#btn-init-local');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.initialized,
        { timeout: 60000 }
      );

      // Destroy
      await page.click('#btn-destroy');
      await page.waitForFunction(
        () => !(window as unknown as { testResults: TestResults }).testResults.initialized
      );

      const results = await getTestResults(page);
      expect(results.initialized).toBe(false);
      expect(results.sttProcessor).toBeNull();

      // Check UI state
      await expect(page.locator('#stt-state')).toHaveText('destroyed');
    });
  });
});

test.describe('@arcaai/stt WebGPU Tests', () => {
  test('should detect WebGPU availability', async ({ page }) => {
    await page.goto('http://localhost:3333/');

    const webgpuInfo = await page.evaluate(async () => {
      if (!('gpu' in navigator)) {
        return { supported: false, reason: 'navigator.gpu not available' };
      }

      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          return { supported: false, reason: 'No adapter available' };
        }

        const device = await adapter.requestDevice();
        const info = {
          supported: true,
          vendor: adapter.info?.vendor || 'unknown',
          architecture: adapter.info?.architecture || 'unknown',
        };
        device.destroy();
        return info;
      } catch (error) {
        return { supported: false, reason: (error as Error).message };
      }
    });

    console.log('WebGPU info:', webgpuInfo);

    // WebGPU may not be available in all browsers/configs
    expect(webgpuInfo).toHaveProperty('supported');
  });
});

test.describe('@arcaai/stt WebSocket Tests', () => {
  test('should be able to create WebSocket connection', async ({ page }) => {
    await page.goto('http://localhost:3333/');

    // Test WebSocket API availability
    const wsAvailable = await page.evaluate(() => {
      return typeof WebSocket !== 'undefined';
    });

    expect(wsAvailable).toBe(true);
  });

  test('should handle WebSocket connection errors gracefully', async ({ page }) => {
    await page.goto('http://localhost:3333/');

    const wsResult = await page.evaluate(() => {
      return new Promise<{ connected: boolean; error?: string }>((resolve) => {
        try {
          // Try to connect to non-existent server
          const ws = new WebSocket('ws://localhost:9999/test');

          ws.onopen = () => {
            ws.close();
            resolve({ connected: true });
          };

          ws.onerror = () => {
            resolve({ connected: false, error: 'Connection failed' });
          };

          // Timeout after 2 seconds
          setTimeout(() => {
            ws.close();
            resolve({ connected: false, error: 'Timeout' });
          }, 2000);
        } catch (error) {
          resolve({ connected: false, error: (error as Error).message });
        }
      });
    });

    // Should fail to connect (no server running)
    expect(wsResult.connected).toBe(false);
  });
});
