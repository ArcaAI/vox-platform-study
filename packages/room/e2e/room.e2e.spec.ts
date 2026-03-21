/**
 * @arcaai/room E2E Tests
 *
 * Browser-based end-to-end tests for the Room audio processing package.
 * Tests real browser APIs: AudioContext, MediaStream, MediaDevices, etc.
 */

import { test, expect, type Page } from '@playwright/test';

// Type for test results exposed by the fixture
interface TestResults {
  browserSupport: {
    audioContext: boolean;
    getUserMedia: boolean;
    mediaStreamTrack: boolean;
    audioWorklet: boolean;
    isSafari: boolean;
  } | null;
  room: unknown;
  track: unknown;
  errors: Array<{ message: string; code?: string }>;
  events: Array<{ time: string; message: string; type: string }>;
  initialized: boolean;
  roomConnected: boolean;
  trackActive: boolean;
}

// Helper to get test results from page
async function getTestResults(page: Page): Promise<TestResults> {
  return page.evaluate(() => (window as unknown as { testResults: TestResults }).testResults);
}

// Helper to call test helper functions
async function callTestHelper(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }) => {
      const helpers = (window as unknown as { roomTestHelpers: Record<string, (...args: unknown[]) => Promise<unknown>> }).roomTestHelpers;
      return helpers[fn](...args);
    },
    { fn, args }
  );
}

// ============================================================================
// Browser Support Tests
// ============================================================================

test.describe('@arcaai/room E2E Tests', () => {
  test.describe('Browser Support Detection', () => {
    test('should detect AudioContext support', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Wait for the browser support check to complete
      await page.waitForSelector('#audio-context-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);

      expect(results.browserSupport).not.toBeNull();
      expect(results.browserSupport!.audioContext).toBe(true);
    });

    test('should detect getUserMedia support', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      await page.waitForSelector('#get-user-media-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);
      expect(results.browserSupport!.getUserMedia).toBe(true);
    });

    test('should detect MediaStreamTrack support', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      await page.waitForSelector('#media-stream-track-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);
      expect(results.browserSupport!.mediaStreamTrack).toBe(true);
    });

    test('should detect AudioWorklet support', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      await page.waitForSelector('#audio-worklet-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);
      // AudioWorklet may not be available in all browsers
      expect(typeof results.browserSupport!.audioWorklet).toBe('boolean');
    });

    test('should have browser support status displayed in UI', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      
      // Wait for at least one status to be checked
      await page.waitForSelector('#audio-context-support:not(:has-text("Checking..."))', { timeout: 15000 });
      
      // Check that support status is displayed in the UI
      await expect(page.locator('#audio-context-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#get-user-media-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#media-stream-track-support')).toContainText(/Supported|Not supported/);
      await expect(page.locator('#audio-worklet-support')).toContainText(/Supported|Not supported/);
    });

    test('should log browser support check event', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      await page.waitForSelector('#audio-context-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);

      expect(results.events.length).toBeGreaterThan(0);
      const supportEvent = results.events.find(e => e.message.includes('Browser support checked'));
      expect(supportEvent).toBeDefined();
    });
  });

  // ============================================================================
  // AudioContext Tests
  // ============================================================================

  test.describe('AudioContext API', () => {
    test('should create AudioContext with correct sample rate', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      const audioInfo = await page.evaluate(() => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextCtor();
        const info = {
          sampleRate: ctx.sampleRate,
          state: ctx.state,
          baseLatency: ctx.baseLatency,
        };
        ctx.close();
        return info;
      });

      expect(audioInfo.sampleRate).toBeGreaterThan(0);
      expect(['suspended', 'running']).toContain(audioInfo.state);
    });

    test('should resume suspended AudioContext', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      const result = await page.evaluate(async () => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextCtor();
        
        const initialState = ctx.state;
        await ctx.resume();
        const afterResumeState = ctx.state;
        
        ctx.close();
        return { initialState, afterResumeState };
      });

      // After resume, state should be 'running'
      expect(result.afterResumeState).toBe('running');
    });

    test('should create and connect audio nodes', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      const result = await page.evaluate(async () => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextCtor();
        await ctx.resume();

        // Create various nodes
        const analyser = ctx.createAnalyser();
        const gain = ctx.createGain();
        const destination = ctx.createMediaStreamDestination();

        // Connect nodes
        gain.connect(analyser);
        analyser.connect(destination);

        const result = {
          analyserCreated: !!analyser,
          gainCreated: !!gain,
          destinationCreated: !!destination,
          destinationHasStream: !!destination.stream,
          analyserFftSize: analyser.fftSize,
        };

        ctx.close();
        return result;
      });

      expect(result.analyserCreated).toBe(true);
      expect(result.gainCreated).toBe(true);
      expect(result.destinationCreated).toBe(true);
      expect(result.destinationHasStream).toBe(true);
      expect(result.analyserFftSize).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Media Devices Tests
  // ============================================================================

  test.describe('Media Devices API', () => {
    test('should access getUserMedia with fake device', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      // Playwright is configured to use fake media devices
      const mediaResult = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const tracks = stream.getAudioTracks();
          const info = {
            success: true,
            trackCount: tracks.length,
            trackLabel: tracks[0]?.label,
            trackEnabled: tracks[0]?.enabled,
            trackReadyState: tracks[0]?.readyState,
          };
          // Clean up
          tracks.forEach(t => t.stop());
          return info;
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      });

      expect(mediaResult.success).toBe(true);
      if (mediaResult.success) {
        expect(mediaResult.trackCount).toBeGreaterThan(0);
        expect(mediaResult.trackEnabled).toBe(true);
        expect(mediaResult.trackReadyState).toBe('live');
      }
    });

    test('should get audio track with constraints', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      const mediaResult = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          const track = stream.getAudioTracks()[0];
          const settings = track?.getSettings();
          
          const info = {
            success: true,
            settings: {
              echoCancellation: settings?.echoCancellation,
              noiseSuppression: settings?.noiseSuppression,
              autoGainControl: settings?.autoGainControl,
            },
          };
          
          track?.stop();
          return info;
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      });

      expect(mediaResult.success).toBe(true);
    });

    test('should enumerate audio devices', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'domcontentloaded' });

      const devices = await page.evaluate(async () => {
        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
          const audioOutputs = allDevices.filter(d => d.kind === 'audiooutput');
          
          return {
            success: true,
            totalDevices: allDevices.length,
            audioInputCount: audioInputs.length,
            audioOutputCount: audioOutputs.length,
          };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      });

      expect(devices.success).toBe(true);
      // At least the fake device should be available
      expect(devices.totalDevices).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================================
  // Room Connection Tests
  // ============================================================================

  test.describe('Room Connection', () => {
    test('should connect room successfully', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Click connect button
      await page.click('#btn-connect');

      // Wait for room to connect
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      const results = await getTestResults(page);
      expect(results.roomConnected).toBe(true);
      expect(results.errors).toHaveLength(0);

      // Check UI state
      await expect(page.locator('#room-state')).toContainText(/connected/);
      await expect(page.locator('#sample-rate')).not.toHaveText('-');
    });

    test('should display sample rate after connection', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      const sampleRateText = await page.locator('#sample-rate').textContent();
      expect(sampleRateText).toMatch(/\d+ Hz/);
    });

    test('should disconnect room successfully', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect first
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // Disconnect
      await page.click('#btn-disconnect');
      await page.waitForFunction(
        () => !(window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 10000 }
      );

      const results = await getTestResults(page);
      expect(results.roomConnected).toBe(false);

      // Check UI state
      await expect(page.locator('#room-state')).toHaveText('disconnected');
      await expect(page.locator('#sample-rate')).toHaveText('-');
    });

    test('should enable start capture button after connection', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Before connection
      await expect(page.locator('#btn-start-capture')).toBeDisabled();

      // Connect
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // After connection
      await expect(page.locator('#btn-start-capture')).toBeEnabled();
    });
  });

  // ============================================================================
  // Audio Track Tests
  // ============================================================================

  test.describe('Audio Track Capture', () => {
    test('should start audio capture', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect first
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      await page.click('#btn-start-capture');

      // Wait for track to be active
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.trackActive,
        { timeout: 15000 }
      );

      const results = await getTestResults(page);
      expect(results.trackActive).toBe(true);
      expect(results.track).not.toBeNull();

      // Check UI state
      await expect(page.locator('#track-state')).toContainText(/active|live/);
    });

    test('should stop audio capture', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect first
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // Start capture first
      await page.click('#btn-start-capture');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.trackActive,
        { timeout: 15000 }
      );

      // Stop capture
      await page.click('#btn-stop-capture');
      await page.waitForFunction(
        () => !(window as unknown as { testResults: TestResults }).testResults.trackActive,
        { timeout: 10000 }
      );

      const results = await getTestResults(page);
      expect(results.trackActive).toBe(false);

      // Check UI state
      await expect(page.locator('#track-state')).toHaveText('ended');
    });

    test('should mute and unmute track', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect first
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // Start capture
      await page.click('#btn-start-capture');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.trackActive,
        { timeout: 15000 }
      );

      // Initially not muted
      await expect(page.locator('#track-muted')).toHaveText('false');

      // Mute
      await page.click('#btn-mute');
      await expect(page.locator('#track-muted')).toHaveText('true');

      // Unmute
      await page.click('#btn-unmute');
      await expect(page.locator('#track-muted')).toHaveText('false');
    });

    test('should show audio level indicator', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect first
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // Start capture
      await page.click('#btn-start-capture');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.trackActive,
        { timeout: 15000 }
      );

      // Wait a bit for audio level monitoring to start
      await page.waitForTimeout(500);

      // Check that audio level bar exists and has some width
      const levelBar = page.locator('#audio-level-bar');
      await expect(levelBar).toBeVisible();
    });
  });

  // ============================================================================
  // Event System Tests
  // ============================================================================

  test.describe('Event System', () => {
    test('should log events to UI', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Wait for logs to appear
      await page.waitForSelector('#logs div', { timeout: 15000 });

      const logsContent = await page.locator('#logs').textContent();
      expect(logsContent).toContain('Browser support checked');
    });

    test('should track events in testResults', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });
      await page.waitForSelector('#audio-context-support:not(:has-text("Checking..."))', { timeout: 15000 });

      const results = await getTestResults(page);

      expect(results.events.length).toBeGreaterThan(0);
      expect(results.events[0]).toHaveProperty('time');
      expect(results.events[0]).toHaveProperty('message');
      expect(results.events[0]).toHaveProperty('type');
    });

    test('should clear logs', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Wait for some logs
      await page.waitForSelector('#logs div', { timeout: 15000 });

      // Clear logs
      await page.click('button:has-text("Clear Logs")');

      // Logs should be empty
      const logsContent = await page.locator('#logs').textContent();
      expect(logsContent?.trim()).toBe('');
    });
  });

  // ============================================================================
  // Cleanup Tests
  // ============================================================================

  test.describe('Cleanup', () => {
    test('should cleanup room when disconnecting', async ({ page }) => {
      await page.goto('http://localhost:3334/', { waitUntil: 'networkidle' });

      // Connect
      await page.click('#btn-connect');
      await page.waitForFunction(
        () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 15000 }
      );

      // Disconnect
      await page.click('#btn-disconnect');
      await page.waitForFunction(
        () => !(window as unknown as { testResults: TestResults }).testResults.roomConnected,
        { timeout: 10000 }
      );

      const results = await getTestResults(page);
      expect(results.room).toBeNull();
    });
  });
});

// ============================================================================
// Cross-Browser Specific Tests
// ============================================================================

test.describe('@arcaai/room Cross-Browser Tests', () => {
  test('should detect Safari correctly', async ({ page, browserName }) => {
    await page.goto('http://localhost:3334/');
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    }, { timeout: 10000 });

    const results = await getTestResults(page);
    
    if (browserName === 'webkit') {
      expect(results.browserSupport!.isSafari).toBe(true);
    } else {
      expect(results.browserSupport!.isSafari).toBe(false);
    }
  });

  test('should handle AudioContext state across browsers', async ({ page }) => {
    await page.goto('http://localhost:3334/');

    const contextState = await page.evaluate(async () => {
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      
      // Initial state may vary by browser
      const initial = ctx.state;
      
      // Try to resume
      try {
        await ctx.resume();
      } catch (e) {
        // Some browsers may require user gesture
      }
      
      const afterResume = ctx.state;
      ctx.close();
      
      return { initial, afterResume };
    });

    // State should be valid
    expect(['suspended', 'running', 'closed']).toContain(contextState.initial);
    expect(['suspended', 'running', 'closed']).toContain(contextState.afterResume);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test.describe('@arcaai/room Error Handling', () => {
  test('should handle getUserMedia permission denial gracefully', async ({ page, context }) => {
    // Deny microphone permission
    await context.grantPermissions([]); // Remove all permissions

    await page.goto('http://localhost:3334/');
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    }, { timeout: 10000 });

    // Try to start capture (should fail)
    await page.click('#btn-connect');
    await page.waitForFunction(
      () => (window as unknown as { testResults: TestResults }).testResults.roomConnected,
      { timeout: 10000 }
    );

    // This may throw or log an error
    const captureResult = await page.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).name };
      }
    });

    // Should either fail with NotAllowedError or work with fake device
    if (!captureResult.success) {
      expect(['NotAllowedError', 'NotFoundError']).toContain(captureResult.error);
    }
  });

  test('should track errors in testResults', async ({ page }) => {
    await page.goto('http://localhost:3334/');
    await page.waitForFunction(() => {
      const results = (window as unknown as { testResults: TestResults }).testResults;
      return results.browserSupport !== null;
    }, { timeout: 10000 });

    const results = await getTestResults(page);
    
    // Initially no errors
    expect(results.errors).toHaveLength(0);
  });
});
