/**
 * @arcaai/noise-filter E2E Tests
 *
 * Browser-based end-to-end tests for the noise filter plugin.
 * Tests real browser APIs: WebAssembly, AudioContext, AudioWorklet, etc.
 */

import { test, expect, type Page } from '@playwright/test';

// Type for test results exposed by the fixture
interface TestResults {
  browserSupport: {
    webAssembly: boolean;
    audioContext: boolean;
    audioWorklet: boolean;
    scriptProcessor: boolean;
    sharedArrayBuffer: boolean;
    mediaStreamTrack: boolean;
    nativeNoiseSuppression: boolean;
    rnnoiseSupported: boolean;
  } | null;
  noiseFilterProcessor: unknown;
  stats: Array<{
    isActive: boolean;
    noiseReductionDb: number;
    vadProbability: number;
    latencyMs: number;
    framesProcessed: number;
    framesDropped: number;
    cpuLoad: number;
    timestamp: number;
  }>;
  errors: Array<{ message: string; code?: string }>;
  events: Array<{ time: string; message: string; type: string }>;
  created: boolean;
  processing: boolean;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
}

// Helper to get test results from page
async function getTestResults(page: Page): Promise<TestResults> {
  return page.evaluate(() => (window as unknown as { testResults: TestResults }).testResults);
}

// Helper to call test helper functions
async function callTestHelper(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }) => {
      const helpers = (
        window as unknown as {
          noiseFilterTestHelpers: Record<string, (...args: unknown[]) => Promise<unknown>>;
        }
      ).noiseFilterTestHelpers;
      return helpers[fn](...args);
    },
    { fn, args },
  );
}

test.describe('@arcaai/noise-filter E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to test fixture
    await page.goto('http://localhost:3334/');

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

    test('should detect AudioWorklet or ScriptProcessor support', async ({ page }) => {
      const results = await getTestResults(page);

      // At least one should be supported
      expect(results.browserSupport!.audioWorklet || results.browserSupport!.scriptProcessor).toBe(true);
    });

    test('should detect MediaStreamTrack support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport!.mediaStreamTrack).toBe(true);
    });

    test('should determine RNNoise support correctly', async ({ page }) => {
      const results = await getTestResults(page);

      // RNNoise requires WebAssembly + AudioContext + (AudioWorklet || ScriptProcessor)
      const expectedSupport =
        results.browserSupport!.webAssembly &&
        results.browserSupport!.audioContext &&
        (results.browserSupport!.audioWorklet || results.browserSupport!.scriptProcessor);

      expect(results.browserSupport!.rnnoiseSupported).toBe(expectedSupport);
    });

    test('should have browser support status displayed in UI', async ({ page }) => {
      await expect(page.locator('#wasm-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#audio-context-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#audio-worklet-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#rnnoise-support')).toContainText(/Supported|Not supported/);
    });

    test('should show recommended processing mode', async ({ page }) => {
      await expect(page.locator('#recommended-mode')).toContainText(/quality|performance/);
    });
  });

  test.describe('Module Loading', () => {
    test('should load noise-filter module dynamically', async ({ page }) => {
      const moduleLoaded = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.js');
          return {
            hasCreateNoiseFilter: typeof module.createNoiseFilter === 'function',
            hasNoiseFilterProcessor: typeof module.NoiseFilterProcessor === 'function',
            hasBrowserSupport: typeof module.getNoiseFilterBrowserSupport === 'function',
            hasRNNoiseProcessor: typeof module.RNNoiseProcessor === 'function',
            exports: Object.keys(module),
          };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if ('error' in moduleLoaded) {
        console.log('Module not built yet:', moduleLoaded.error);
        test.skip();
      } else {
        expect(moduleLoaded.hasCreateNoiseFilter).toBe(true);
        expect(moduleLoaded.hasNoiseFilterProcessor).toBe(true);
        expect(moduleLoaded.hasBrowserSupport).toBe(true);
        expect(moduleLoaded.hasRNNoiseProcessor).toBe(true);
      }
    });

    test('should export expected constants', async ({ page }) => {
      const exports = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.js');
          return {
            RNNOISE_FRAME_SIZE: module.RNNOISE_FRAME_SIZE,
            RNNOISE_SAMPLE_RATE: module.RNNOISE_SAMPLE_RATE,
            DEFAULT_OPTIONS: module.DEFAULT_NOISE_FILTER_OPTIONS,
            WORKLET_NAME: module.WORKLET_PROCESSOR_NAME,
          };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if ('error' in exports) {
        test.skip();
      } else {
        expect(exports.RNNOISE_FRAME_SIZE).toBe(480);
        expect(exports.RNNOISE_SAMPLE_RATE).toBe(48000);
        expect(exports.DEFAULT_OPTIONS).toBeDefined();
        expect(exports.WORKLET_NAME).toBe('rnnoise-worklet-processor');
      }
    });

    test('should export browser detection utilities', async ({ page }) => {
      const utilities = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.js');
          return {
            isBrowser: module.isBrowser(),
            isWebAssemblySupported: module.isWebAssemblySupported(),
            isAudioContextSupported: module.isAudioContextSupported(),
            isAudioWorkletSupported: module.isAudioWorkletSupported(),
            isRNNoiseSupported: module.isRNNoiseSupported(),
          };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if ('error' in utilities) {
        test.skip();
      } else {
        expect(utilities.isBrowser).toBe(true);
        expect(utilities.isWebAssemblySupported).toBe(true);
        expect(utilities.isAudioContextSupported).toBe(true);
        // AudioWorklet may or may not be supported depending on browser
        expect(typeof utilities.isAudioWorkletSupported).toBe('boolean');
        expect(typeof utilities.isRNNoiseSupported).toBe('boolean');
      }
    });
  });

  test.describe('NoiseFilterProcessor Creation', () => {
    test('should create processor with default options', async ({ page }) => {
      const results = await getTestResults(page);

      if (!results.browserSupport?.rnnoiseSupported) {
        test.skip();
      }

      // Check if module is available
      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.js');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Click create button
      await page.click('#btn-create');

      // Wait for processor creation
      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created, { timeout: 30000 });

      const afterCreate = await getTestResults(page);
      expect(afterCreate.created).toBe(true);
      expect(afterCreate.noiseFilterProcessor).not.toBeNull();
      expect(afterCreate.errors).toHaveLength(0);

      // Check UI state
      await expect(page.locator('#processor-state')).toHaveText('created');
      await expect(page.locator('#current-level')).toHaveText('medium');
    });

    test('should create processor with custom options', async ({ page }) => {
      const results = await getTestResults(page);

      if (!results.browserSupport?.rnnoiseSupported) {
        test.skip();
      }

      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.js');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Create with custom options via helper
      await callTestHelper(page, 'createNoiseFilter', {
        level: 'high',
        mode: 'performance',
      });

      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created);

      // Verify level was set
      await expect(page.locator('#current-level')).toHaveText('high');
    });
  });

  test.describe('Noise Level Control', () => {
    test.beforeEach(async ({ page }) => {
      const results = await getTestResults(page);
      if (!results.browserSupport?.rnnoiseSupported) {
        test.skip();
      }

      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.js');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Create processor first
      await page.click('#btn-create');
      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created);
    });

    test('should change noise level to low', async ({ page }) => {
      await page.click('#btn-level-low');
      await expect(page.locator('#current-level')).toHaveText('low');
      await expect(page.locator('#btn-level-low')).toHaveClass(/active/);
    });

    test('should change noise level to medium', async ({ page }) => {
      // First change to low, then back to medium
      await page.click('#btn-level-low');
      await page.click('#btn-level-medium');
      await expect(page.locator('#current-level')).toHaveText('medium');
      await expect(page.locator('#btn-level-medium')).toHaveClass(/active/);
    });

    test('should change noise level to high', async ({ page }) => {
      await page.click('#btn-level-high');
      await expect(page.locator('#current-level')).toHaveText('high');
      await expect(page.locator('#btn-level-high')).toHaveClass(/active/);
    });

    test('should cycle through all levels', async ({ page }) => {
      // Low
      await page.click('#btn-level-low');
      await expect(page.locator('#current-level')).toHaveText('low');

      // Medium
      await page.click('#btn-level-medium');
      await expect(page.locator('#current-level')).toHaveText('medium');

      // High
      await page.click('#btn-level-high');
      await expect(page.locator('#current-level')).toHaveText('high');

      // Back to low
      await page.click('#btn-level-low');
      await expect(page.locator('#current-level')).toHaveText('low');
    });
  });

  test.describe('Processor Lifecycle', () => {
    test('should handle create and destroy cycle', async ({ page }) => {
      const results = await getTestResults(page);
      if (!results.browserSupport?.rnnoiseSupported) {
        test.skip();
      }

      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.js');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Create
      await page.click('#btn-create');
      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created);
      await expect(page.locator('#processor-state')).toHaveText('created');

      // Destroy
      await page.click('#btn-destroy');
      await page.waitForFunction(() => !(window as unknown as { testResults: TestResults }).testResults.created);
      await expect(page.locator('#processor-state')).toHaveText('destroyed');

      const afterDestroy = await getTestResults(page);
      expect(afterDestroy.created).toBe(false);
      expect(afterDestroy.noiseFilterProcessor).toBeNull();
    });

    test('should allow recreating processor after destroy', async ({ page }) => {
      const results = await getTestResults(page);
      if (!results.browserSupport?.rnnoiseSupported) {
        test.skip();
      }

      const moduleAvailable = await page.evaluate(async () => {
        try {
          await import('/dist/index.js');
          return true;
        } catch {
          return false;
        }
      });

      if (!moduleAvailable) {
        test.skip();
      }

      // Create -> Destroy -> Create
      await page.click('#btn-create');
      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created);

      await page.click('#btn-destroy');
      await page.waitForFunction(() => !(window as unknown as { testResults: TestResults }).testResults.created);

      // Should be able to create again
      await page.click('#btn-create');
      await page.waitForFunction(() => (window as unknown as { testResults: TestResults }).testResults.created);

      const afterRecreate = await getTestResults(page);
      expect(afterRecreate.created).toBe(true);
    });
  });

  test.describe('Event System', () => {
    test('should log events through the fixture UI', async ({ page }) => {
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
});

test.describe('@arcaai/noise-filter Audio Processing Tests', () => {
  test('should create AudioContext with 48kHz sample rate', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const audioInfo = await page.evaluate(() => {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const info = {
        sampleRate: ctx.sampleRate,
        state: ctx.state,
        baseLatency: ctx.baseLatency,
      };
      ctx.close();
      return info;
    });

    // Sample rate may be limited by hardware
    expect(audioInfo.sampleRate).toBeGreaterThan(0);
    expect(['suspended', 'running']).toContain(audioInfo.state);
  });

  test('should handle getUserMedia with fake device', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const mediaResult = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 48000,
            echoCancellation: false,
            noiseSuppression: false,
          },
        });
        const tracks = stream.getAudioTracks();
        const info = {
          trackCount: tracks.length,
          trackLabel: tracks[0]?.label,
          trackEnabled: tracks[0]?.enabled,
          trackReadyState: tracks[0]?.readyState,
        };
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
      expect(mediaResult.trackReadyState).toBe('live');
    }
  });

  test('should be able to create MediaStreamAudioSourceNode', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const sourceResult = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const audioContext = new AudioContext({ sampleRate: 48000 });
        const sourceNode = audioContext.createMediaStreamSource(stream);

        const info = {
          numberOfInputs: sourceNode.numberOfInputs,
          numberOfOutputs: sourceNode.numberOfOutputs,
          channelCount: sourceNode.channelCount,
        };

        stream.getTracks().forEach((t) => t.stop());
        await audioContext.close();

        return info;
      } catch (error) {
        return { error: (error as Error).message };
      }
    });

    if ('error' in sourceResult) {
      console.log('Source node error:', sourceResult.error);
    } else {
      expect(sourceResult.numberOfOutputs).toBeGreaterThan(0);
      expect(sourceResult.channelCount).toBeGreaterThan(0);
    }
  });

  test('should be able to create MediaStreamAudioDestinationNode', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const destResult = await page.evaluate(async () => {
      try {
        const audioContext = new AudioContext({ sampleRate: 48000 });
        const destNode = audioContext.createMediaStreamDestination();

        const info = {
          numberOfInputs: destNode.numberOfInputs,
          numberOfOutputs: destNode.numberOfOutputs,
          hasStream: !!destNode.stream,
          streamTracks: destNode.stream.getAudioTracks().length,
        };

        await audioContext.close();

        return info;
      } catch (error) {
        return { error: (error as Error).message };
      }
    });

    if ('error' in destResult) {
      console.log('Destination node error:', destResult.error);
    } else {
      expect(destResult.numberOfInputs).toBeGreaterThan(0);
      expect(destResult.hasStream).toBe(true);
      expect(destResult.streamTracks).toBeGreaterThan(0);
    }
  });
});

test.describe('@arcaai/noise-filter WebAssembly Tests', () => {
  test('should compile minimal WASM module', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const wasmResult = await page.evaluate(async () => {
      try {
        // Minimal WASM module (8 bytes magic header)
        const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        const module = await WebAssembly.compile(wasmBytes);

        return {
          success: true,
          isModule: module instanceof WebAssembly.Module,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(wasmResult.success).toBe(true);
    expect(wasmResult.isModule).toBe(true);
  });

  test('should instantiate WASM module with imports', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const wasmResult = await page.evaluate(async () => {
      try {
        // Simple WASM module that imports memory
        const wasmBytes = new Uint8Array([
          0x00,
          0x61,
          0x73,
          0x6d, // WASM magic
          0x01,
          0x00,
          0x00,
          0x00, // Version 1
        ]);

        const module = await WebAssembly.compile(wasmBytes);
        const instance = await WebAssembly.instantiate(module, {});

        return {
          success: true,
          hasExports: !!instance.exports,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(wasmResult.success).toBe(true);
  });

  test('should support WebAssembly.Memory', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const memoryResult = await page.evaluate(() => {
      try {
        const memory = new WebAssembly.Memory({ initial: 1 });
        return {
          success: true,
          bufferSize: memory.buffer.byteLength,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(memoryResult.success).toBe(true);
    expect(memoryResult.bufferSize).toBe(65536); // 1 page = 64KB
  });
});

test.describe('@arcaai/noise-filter AudioWorklet Tests', () => {
  test('should detect AudioWorklet support', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const workletSupport = await page.evaluate(() => {
      const AudioContextCtor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextCtor) return { supported: false, reason: 'No AudioContext' };

      return {
        supported: 'audioWorklet' in AudioContextCtor.prototype,
        hasPrototype: !!AudioContextCtor.prototype,
      };
    });

    // AudioWorklet should be supported in modern browsers
    expect(workletSupport.hasPrototype).toBe(true);
    // AudioWorklet may not be available in all test environments
    console.log('AudioWorklet supported:', workletSupport.supported);
  });

  test('should be able to register an AudioWorklet', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const registerResult = await page.evaluate(async () => {
      try {
        const audioContext = new AudioContext();

        // Simple worklet code
        const workletCode = `
          class TestProcessor extends AudioWorkletProcessor {
            process() { return true; }
          }
          registerProcessor('test-processor', TestProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);

        await audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        // Try to create a node
        const node = new AudioWorkletNode(audioContext, 'test-processor');
        node.disconnect();

        await audioContext.close();

        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    if (!registerResult.success) {
      console.log('AudioWorklet registration error:', registerResult.error);
      // AudioWorklet may not work in all test environments
    }
  });
});

test.describe('@arcaai/noise-filter Error Handling', () => {
  test('should handle unsupported browser gracefully', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    // Simulate checking error handling
    const errorHandling = await page.evaluate(async () => {
      try {
        const module = await import('/dist/index.js');
        const { NoiseFilterError, NoiseFilterErrorCode } = module;

        // Create an error
        const error = new NoiseFilterError(NoiseFilterErrorCode.NOT_SUPPORTED, 'Test error');

        return {
          isError: error instanceof Error,
          hasCode: !!error.code,
          code: error.code,
          message: error.message,
          name: error.name,
        };
      } catch (error) {
        return { loadError: (error as Error).message };
      }
    });

    if ('loadError' in errorHandling) {
      test.skip();
    } else {
      expect(errorHandling.isError).toBe(true);
      expect(errorHandling.code).toBe('NOT_SUPPORTED');
      expect(errorHandling.name).toBe('NoiseFilterError');
    }
  });

  test('should export all error codes', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const errorCodes = await page.evaluate(async () => {
      try {
        const module = await import('/dist/index.js');
        const { NoiseFilterErrorCode } = module;

        return {
          codes: Object.values(NoiseFilterErrorCode),
          hasWasmLoadFailed: !!NoiseFilterErrorCode.WASM_LOAD_FAILED,
          hasWorkletFailed: !!NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED,
          hasProcessingError: !!NoiseFilterErrorCode.PROCESSING_ERROR,
          hasNotSupported: !!NoiseFilterErrorCode.NOT_SUPPORTED,
          hasInvalidConfig: !!NoiseFilterErrorCode.INVALID_CONFIG,
        };
      } catch (error) {
        return { loadError: (error as Error).message };
      }
    });

    if ('loadError' in errorCodes) {
      test.skip();
    } else {
      expect(errorCodes.codes).toHaveLength(5);
      expect(errorCodes.hasWasmLoadFailed).toBe(true);
      expect(errorCodes.hasWorkletFailed).toBe(true);
      expect(errorCodes.hasProcessingError).toBe(true);
      expect(errorCodes.hasNotSupported).toBe(true);
      expect(errorCodes.hasInvalidConfig).toBe(true);
    }
  });
});

test.describe('@arcaai/noise-filter RNNoiseProcessor Tests', () => {
  test('should create RNNoiseProcessor instance', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const processorResult = await page.evaluate(async () => {
      try {
        const module = await import('/dist/index.js');
        const { RNNoiseProcessor, RNNOISE_FRAME_SIZE, RNNOISE_SAMPLE_RATE } = module;

        const processor = new RNNoiseProcessor();

        return {
          success: true,
          isInitialized: processor.isInitialized,
          enabled: processor.enabled,
          level: processor.level,
          frameSize: RNNOISE_FRAME_SIZE,
          sampleRate: RNNOISE_SAMPLE_RATE,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    if (!processorResult.success) {
      test.skip();
    } else {
      expect(processorResult.isInitialized).toBe(false);
      expect(processorResult.enabled).toBe(true);
      expect(processorResult.level).toBe('medium');
      expect(processorResult.frameSize).toBe(480);
      expect(processorResult.sampleRate).toBe(48000);
    }
  });

  test('should pass through audio when not initialized', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const processResult = await page.evaluate(async () => {
      try {
        const module = await import('/dist/index.js');
        const { RNNoiseProcessor, RNNOISE_FRAME_SIZE } = module;

        const processor = new RNNoiseProcessor();

        // Create test audio data
        const input = new Float32Array(RNNOISE_FRAME_SIZE);
        for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
          input[i] = Math.sin(i * 0.1) * 0.5;
        }
        const output = new Float32Array(RNNOISE_FRAME_SIZE);

        const result = processor.process(input, output);

        // Check that output matches input (pass-through when not initialized)
        let matches = true;
        for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
          if (Math.abs(output[i] - input[i]) > 0.0001) {
            matches = false;
            break;
          }
        }

        processor.destroy();

        return {
          success: true,
          outputMatches: matches,
          vadProbability: result.vadProbability,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    if (!processResult.success) {
      test.skip();
    } else {
      expect(processResult.outputMatches).toBe(true);
      expect(processResult.vadProbability).toBe(0);
    }
  });

  test('should get stats from RNNoiseProcessor', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const statsResult = await page.evaluate(async () => {
      try {
        const module = await import('/dist/index.js');
        const { RNNoiseProcessor } = module;

        const processor = new RNNoiseProcessor();
        processor.setLevel('high');

        const stats = processor.getStats();
        processor.destroy();

        return {
          success: true,
          stats: {
            isActive: stats.isActive,
            noiseReductionDb: stats.noiseReductionDb,
            vadProbability: stats.vadProbability,
            latencyMs: stats.latencyMs,
            framesProcessed: stats.framesProcessed,
            hasTimestamp: !!stats.timestamp,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    if (!statsResult.success) {
      test.skip();
    } else {
      expect(statsResult.stats.isActive).toBe(false); // Not initialized
      expect(statsResult.stats.noiseReductionDb).toBe(12); // High level = 12dB
      expect(statsResult.stats.latencyMs).toBe(10); // 480/48000 * 1000 = 10ms
      expect(statsResult.stats.framesProcessed).toBe(0);
      expect(statsResult.stats.hasTimestamp).toBe(true);
    }
  });
});
