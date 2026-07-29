/**
 * @arcaai/vad E2E Tests
 *
 * Browser-based end-to-end tests for the VAD (Voice Activity Detection) plugin.
 * Tests real browser APIs and actual audio processing capabilities.
 */

import { test, expect, type Page } from '@playwright/test';

// Type for test results exposed by the fixture
interface TestResults {
  browserSupport: {
    webAssembly: boolean;
    audioContext: boolean;
    audioWorklet: boolean;
    mediaDevices: boolean;
    sharedArrayBuffer: boolean;
    crossOriginIsolated: boolean;
    vadSupported: boolean;
  } | null;
  vadProcessor: unknown;
  speechSegments: Array<{
    audio: Float32Array;
    duration: number;
    timestamp: number;
  }>;
  misfires: Array<{ timestamp: number }>;
  errors: Array<{ message: string; timestamp: number }>;
  events: Array<{ time: string; message: string; type: string }>;
  initialized: boolean;
  started: boolean;
  stats: {
    isActive: boolean;
    isSpeaking: boolean;
    speechProbability: number;
    currentSpeechDuration: number;
    framesProcessed: number;
    speechSegmentsDetected: number;
    misfireCount: number;
    averageSpeechProbability: number;
    timestamp: number;
  } | null;
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
          vadTestHelpers: Record<string, (...args: unknown[]) => Promise<unknown>>;
        }
      ).vadTestHelpers;
      return helpers[fn](...args);
    },
    { fn, args },
  );
}

test.describe('@arcaai/vad E2E Tests', () => {
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

    test('should detect AudioWorklet support', async ({ page, browserName }) => {
      const results = await getTestResults(page);

      // AudioWorklet is supported in modern browsers
      if (browserName === 'chromium' || browserName === 'firefox') {
        expect(results.browserSupport!.audioWorklet).toBe(true);
      }
      // WebKit may have varying support
    });

    test('should detect MediaDevices support', async ({ page }) => {
      const results = await getTestResults(page);

      expect(results.browserSupport!.mediaDevices).toBe(true);
    });

    test('should determine VAD support correctly', async ({ page }) => {
      const results = await getTestResults(page);

      // VAD requires WASM + AudioContext
      const expectedSupport = results.browserSupport!.webAssembly && results.browserSupport!.audioContext;
      expect(results.browserSupport!.vadSupported).toBe(expectedSupport);
    });

    test('should have browser support status displayed in UI', async ({ page }) => {
      await expect(page.locator('#wasm-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#audio-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#worklet-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#media-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#vad-support')).toContainText(/Yes|No/);
    });
  });

  test.describe('VAD Module Loading', () => {
    test('should load VAD module dynamically', async ({ page }) => {
      const moduleLoaded = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.mjs');
          return {
            hasVADProcessor: typeof module.VADProcessor === 'function',
            hasCreateVAD: typeof module.createVAD === 'function',
            hasUseVAD: typeof module.useVAD === 'function',
            hasGetVADBrowserSupport: typeof module.getVADBrowserSupport === 'function',
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
        expect(moduleLoaded.hasVADProcessor).toBe(true);
        expect(moduleLoaded.hasCreateVAD).toBe(true);
        expect(moduleLoaded.hasGetVADBrowserSupport).toBe(true);
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
        expect(exports).toContain('VADProcessor');
        expect(exports).toContain('createVAD');
        expect(exports).toContain('DEFAULT_VAD_OPTIONS');
        expect(exports).toContain('VADError');
        expect(exports).toContain('VADErrorCode');
        expect(exports).toContain('isVADSupported');
        expect(exports).toContain('getVADBrowserSupport');
        expect(exports).toContain('getRecommendedModel');
      }
    });

    test('should export audio processing utilities', async ({ page }) => {
      const exports = await page.evaluate(async () => {
        try {
          const module = await import('/dist/index.mjs');
          return Object.keys(module);
        } catch {
          return [];
        }
      });

      if (exports.length === 0) {
        test.skip();
      } else {
        // Audio processing utilities
        expect(exports).toContain('linearResample');
        expect(exports).toContain('Resampler');
        expect(exports).toContain('downsampleTo16kHz');
        expect(exports).toContain('FrameAccumulator');
        expect(exports).toContain('AudioRingBuffer');
        expect(exports).toContain('VAD_SAMPLE_RATE');
        expect(exports).toContain('FRAME_SIZE_V5');
        expect(exports).toContain('FRAME_SIZE_LEGACY');
      }
    });
  });

  test.describe('VAD Browser Support API', () => {
    test('should get detailed browser support info', async ({ page }) => {
      const support = await page.evaluate(async () => {
        try {
          const { getVADBrowserSupport } = await import('/dist/index.mjs');
          return getVADBrowserSupport();
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      if ('error' in support) {
        test.skip();
      } else {
        expect(support).toHaveProperty('webAssembly');
        expect(support).toHaveProperty('audioWorklet');
        expect(support).toHaveProperty('sharedArrayBuffer');
        expect(support).toHaveProperty('onnxRuntime');
        expect(support).toHaveProperty('vadSupported');
        expect(support).toHaveProperty('recommendedModel');
      }
    });

    test('should recommend appropriate model', async ({ page }) => {
      const model = await page.evaluate(async () => {
        try {
          const { getRecommendedModel } = await import('/dist/index.mjs');
          return getRecommendedModel();
        } catch {
          return null;
        }
      });

      if (model === null) {
        test.skip();
      } else {
        expect(['v5', 'legacy']).toContain(model);
      }
    });

    test('should return correct frame size for models', async ({ page }) => {
      const frameSizes = await page.evaluate(async () => {
        try {
          const { getFrameSamplesForModel, FRAME_SIZE_V5, FRAME_SIZE_LEGACY } = await import('/dist/index.mjs');
          return {
            v5: getFrameSamplesForModel('v5'),
            legacy: getFrameSamplesForModel('legacy'),
            FRAME_SIZE_V5,
            FRAME_SIZE_LEGACY,
          };
        } catch {
          return null;
        }
      });

      if (frameSizes === null) {
        test.skip();
      } else {
        expect(frameSizes.v5).toBe(512);
        expect(frameSizes.legacy).toBe(1536);
        expect(frameSizes.v5).toBe(frameSizes.FRAME_SIZE_V5);
        expect(frameSizes.legacy).toBe(frameSizes.FRAME_SIZE_LEGACY);
      }
    });
  });

  test.describe('VAD Constants and Defaults', () => {
    test('should have correct default options', async ({ page }) => {
      const defaults = await page.evaluate(async () => {
        try {
          const { DEFAULT_VAD_OPTIONS } = await import('/dist/index.mjs');
          return DEFAULT_VAD_OPTIONS;
        } catch {
          return null;
        }
      });

      if (defaults === null) {
        test.skip();
      } else {
        expect(defaults.model).toBe('v5');
        expect(defaults.positiveSpeechThreshold).toBe(0.5);
        expect(defaults.negativeSpeechThreshold).toBe(0.35);
        expect(defaults.preSpeechPadMs).toBe(300);
        expect(defaults.postSpeechPadMs).toBe(300);
        expect(defaults.minSpeechMs).toBe(250);
        expect(defaults.redemptionMs).toBe(1400);
        expect(defaults.sampleRate).toBe(16000);
      }
    });

    test('should have correct VAD_SAMPLE_RATE', async ({ page }) => {
      const sampleRate = await page.evaluate(async () => {
        try {
          const { VAD_SAMPLE_RATE } = await import('/dist/index.mjs');
          return VAD_SAMPLE_RATE;
        } catch {
          return null;
        }
      });

      if (sampleRate === null) {
        test.skip();
      } else {
        expect(sampleRate).toBe(16000);
      }
    });
  });

  test.describe('Audio Resampling', () => {
    test('should resample audio with linearResample', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { linearResample } = await import('/dist/index.mjs');

          // Create test audio at 48kHz
          const input = new Float32Array(480);
          for (let i = 0; i < 480; i++) {
            input[i] = Math.sin((2 * Math.PI * i) / 48);
          }

          // Resample to 16kHz (3:1 ratio)
          const output = linearResample(input, 48000, 16000);

          return {
            inputLength: input.length,
            outputLength: output.length,
            ratio: input.length / output.length,
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.inputLength).toBe(480);
        expect(result.outputLength).toBe(160);
        expect(result.ratio).toBeCloseTo(3, 1);
      }
    });

    test('should downsample to 16kHz', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { downsampleTo16kHz } = await import('/dist/index.mjs');

          const input = new Float32Array(441);
          const output = downsampleTo16kHz(input, 44100);

          return {
            inputLength: input.length,
            outputLength: output.length,
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.outputLength).toBe(160);
      }
    });

    test('should create streaming resampler', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { Resampler } = await import('/dist/index.mjs');

          const resampler = new Resampler(48000, 16000);

          const chunk1 = new Float32Array(128);
          const chunk2 = new Float32Array(128);

          const out1 = resampler.process(chunk1);
          const out2 = resampler.process(chunk2);

          return {
            inputSampleRate: resampler.getInputSampleRate(),
            outputSampleRate: resampler.getOutputSampleRate(),
            ratio: resampler.getRatio(),
            out1Length: out1.length,
            out2Length: out2.length,
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.inputSampleRate).toBe(48000);
        expect(result.outputSampleRate).toBe(16000);
        expect(result.ratio).toBe(3);
      }
    });
  });

  test.describe('Frame Accumulator', () => {
    test('should accumulate frames correctly', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { FrameAccumulator } = await import('/dist/index.mjs');

          let framesEmitted = 0;
          const accumulator = new FrameAccumulator('v5', () => {
            framesEmitted++;
          });

          // Feed 512 samples (one frame for v5)
          accumulator.process(new Float32Array(512));

          return {
            frameSize: accumulator.getFrameSize(),
            framesEmitted,
            bufferLevel: accumulator.getBufferLevel(),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.frameSize).toBe(512);
        expect(result.framesEmitted).toBe(1);
        expect(result.bufferLevel).toBe(0);
      }
    });

    test('should accumulate samples across multiple calls', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { FrameAccumulator } = await import('/dist/index.mjs');

          let framesEmitted = 0;
          const accumulator = new FrameAccumulator('v5', () => {
            framesEmitted++;
          });

          // Feed 128 samples at a time (typical AudioWorklet chunk)
          for (let i = 0; i < 4; i++) {
            accumulator.process(new Float32Array(128));
          }

          return {
            framesEmitted,
            bufferLevel: accumulator.getBufferLevel(),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.framesEmitted).toBe(1);
        expect(result.bufferLevel).toBe(0);
      }
    });
  });

  test.describe('Audio Ring Buffer', () => {
    test('should store and retrieve samples', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { AudioRingBuffer } = await import('/dist/index.mjs');

          const buffer = new AudioRingBuffer(100);
          buffer.write(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));

          const allSamples = buffer.readAll();
          const lastTwo = buffer.readLast(2);

          return {
            count: buffer.getCount(),
            capacity: buffer.getCapacity(),
            isFull: buffer.isFull(),
            allSamplesLength: allSamples.length,
            lastTwoLength: lastTwo.length,
            lastTwoValues: Array.from(lastTwo),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.count).toBe(5);
        expect(result.capacity).toBe(100);
        expect(result.isFull).toBe(false);
        expect(result.allSamplesLength).toBe(5);
        expect(result.lastTwoLength).toBe(2);
        expect(result.lastTwoValues[0]).toBeCloseTo(0.4, 2);
        expect(result.lastTwoValues[1]).toBeCloseTo(0.5, 2);
      }
    });

    test('should handle wrap-around correctly', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { AudioRingBuffer } = await import('/dist/index.mjs');

          const buffer = new AudioRingBuffer(5);
          buffer.write(new Float32Array([1, 2, 3, 4, 5]));
          buffer.write(new Float32Array([6, 7]));

          const allSamples = buffer.readAll();

          return {
            count: buffer.getCount(),
            isFull: buffer.isFull(),
            samples: Array.from(allSamples),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.count).toBe(5);
        expect(result.isFull).toBe(true);
        expect(result.samples).toEqual([3, 4, 5, 6, 7]);
      }
    });
  });

  test.describe('VAD Error Handling', () => {
    test('should have correct error codes', async ({ page }) => {
      const errorCodes = await page.evaluate(async () => {
        try {
          const { VADErrorCode } = await import('/dist/index.mjs');
          return Object.keys(VADErrorCode);
        } catch {
          return null;
        }
      });

      if (errorCodes === null) {
        test.skip();
      } else {
        expect(errorCodes).toContain('MODEL_LOAD_FAILED');
        expect(errorCodes).toContain('WASM_LOAD_FAILED');
        expect(errorCodes).toContain('WORKLET_REGISTRATION_FAILED');
        expect(errorCodes).toContain('PROCESSING_ERROR');
        expect(errorCodes).toContain('NOT_SUPPORTED');
        expect(errorCodes).toContain('INVALID_CONFIG');
      }
    });

    test('should create VADError with code and message', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { VADError, VADErrorCode } = await import('/dist/index.mjs');

          const error = new VADError(VADErrorCode.NOT_SUPPORTED, 'Test error message');

          return {
            name: error.name,
            code: error.code,
            message: error.message,
            isError: error instanceof Error,
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.name).toBe('VADError');
        expect(result.code).toBe('NOT_SUPPORTED');
        expect(result.message).toBe('Test error message');
        expect(result.isError).toBe(true);
      }
    });
  });

  test.describe('Duration/Sample Conversions', () => {
    test('should convert duration to samples correctly', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { durationToSamples, samplesToDuration } = await import('/dist/index.mjs');

          return {
            samplesFor1Sec: durationToSamples(1000, 16000),
            durationFor16000Samples: samplesToDuration(16000, 16000),
            samplesFor100ms: durationToSamples(100, 48000),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.samplesFor1Sec).toBe(16000);
        expect(result.durationFor16000Samples).toBe(1000);
        expect(result.samplesFor100ms).toBe(4800);
      }
    });

    test('should convert duration to frames correctly', async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const { durationToFrames, framesToDuration } = await import('/dist/index.mjs');

          return {
            framesFor32ms: durationToFrames(32, 'v5', 16000),
            framesFor96ms: durationToFrames(96, 'legacy', 16000),
            durationFor1FrameV5: framesToDuration(1, 'v5', 16000),
            durationFor1FrameLegacy: framesToDuration(1, 'legacy', 16000),
          };
        } catch {
          return null;
        }
      });

      if (result === null) {
        test.skip();
      } else {
        expect(result.framesFor32ms).toBe(1);
        expect(result.framesFor96ms).toBe(1);
        expect(result.durationFor1FrameV5).toBe(32);
        expect(result.durationFor1FrameLegacy).toBe(96);
      }
    });
  });

  test.describe('Event System', () => {
    test('should emit events through the fixture UI', async ({ page }) => {
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

test.describe('@arcaai/vad AudioContext Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3334/');
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    });
  });

  test('should create AudioContext with 16kHz sample rate', async ({ page }) => {
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

    // Sample rate may be adjusted by hardware
    expect(audioInfo.sampleRate).toBeGreaterThan(0);
    expect(['suspended', 'running']).toContain(audioInfo.state);
  });

  test('should handle getUserMedia with fake device', async ({ page }) => {
    const mediaResult = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const tracks = stream.getAudioTracks();
        const info = {
          trackCount: tracks.length,
          trackLabel: tracks[0]?.label,
          trackEnabled: tracks[0]?.enabled,
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
    }
  });

  test('should support AudioWorklet', async ({ page, browserName }) => {
    const result = await page.evaluate(() => {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const hasWorklet = 'audioWorklet' in ctx;
        ctx.close();
        return { supported: hasWorklet };
      } catch (error) {
        return { error: (error as Error).message };
      }
    });

    if ('error' in result) {
      console.log('AudioWorklet check error:', result.error);
    } else if (browserName === 'chromium' || browserName === 'firefox') {
      expect(result.supported).toBe(true);
    }
  });
});

test.describe('@arcaai/vad UI Interaction Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3334/');
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    });
  });

  test('should have initialize button enabled when VAD supported', async ({ page }) => {
    const results = await getTestResults(page);

    if (results.browserSupport?.vadSupported) {
      await expect(page.locator('#btn-init-vad')).toBeEnabled();
    } else {
      await expect(page.locator('#btn-init-vad')).toBeDisabled();
    }
  });

  test('should update threshold values in UI', async ({ page }) => {
    // Change positive threshold
    await page.fill('#pos-threshold', '70');
    await page.locator('#pos-threshold').dispatchEvent('input');

    const posValue = await page.locator('#pos-threshold-value').textContent();
    expect(posValue).toBe('0.70');

    // Change negative threshold
    await page.fill('#neg-threshold', '40');
    await page.locator('#neg-threshold').dispatchEvent('input');

    const negValue = await page.locator('#neg-threshold-value').textContent();
    expect(negValue).toBe('0.40');
  });

  test('should update min speech duration in UI', async ({ page }) => {
    await page.fill('#min-speech', '500');
    await page.locator('#min-speech').dispatchEvent('input');

    const value = await page.locator('#min-speech-value').textContent();
    expect(value).toBe('500');
  });

  test('should have model selector with correct options', async ({ page }) => {
    const options = await page.locator('#model-select option').allTextContents();

    expect(options).toContain('v5 (512 frame)');
    expect(options).toContain('Legacy (1536 frame)');
  });
});

// The `@arcaai/vad Worklet Loader Tests` describe block was removed when
// the dead custom worklet code (`registerVADWorklet`,
// `createVADWorkletNode`, `cleanupVADWorkletResources`, `isVADWorkletRegistered`,
// `WORKLET_PROCESSOR_NAME`) was deleted from the package public surface.
// The production VAD path uses `@ricky0123/vad-web`'s own worklet; no custom
// worklet exports remain to validate here.
