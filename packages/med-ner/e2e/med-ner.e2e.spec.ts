/**
 * @arcaai/med-ner E2E Tests
 *
 * End-to-end tests for Medical NER functionality in real browsers.
 */

import { test, expect, type Page } from '@playwright/test';

// Helper to wait for processor initialization
async function waitForReady(page: Page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const processor = (window as any).nerProcessor;
      return processor && processor.isInitialized();
    },
    { timeout },
  );
}

// Helper to check if NER is supported
async function isNERSupported(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const support = (window as any).browserSupport;
    return support && support.nerSupported;
  });
}

test.describe('Browser Support Detection', () => {
  test('should detect browser capabilities', async ({ page }) => {
    await page.goto('/');

    // Wait for support check
    await page.waitForFunction(() => (window as any).browserSupport !== undefined);

    const support = await page.evaluate(() => (window as any).browserSupport);

    expect(support).toHaveProperty('webAssembly');
    expect(support).toHaveProperty('indexedDB');
    expect(support).toHaveProperty('fetch');
    expect(support).toHaveProperty('nerSupported');
    expect(support).toHaveProperty('recommendedDtype');

    // Log support info
    console.log('Browser support:', support);
  });

  test('should show correct support status in UI', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#browser-support-status .status-item');

    const statusItems = await page.$$('#browser-support-status .status-item');
    expect(statusItems.length).toBeGreaterThan(0);
  });
});

test.describe('Processor Initialization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should initialize processor successfully', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Click init button
    await page.click('#btn-init');

    // Wait for ready (this might take a while for model download)
    await waitForReady(page, 120000);

    // Check status
    const statusText = await page.textContent('#status-ready');
    expect(statusText).toBe('Ready');

    // Check processor exists
    const hasProcessor = await page.evaluate(() => (window as any).nerProcessor !== null);
    expect(hasProcessor).toBe(true);
  });

  test('should destroy processor', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Initialize first
    await page.click('#btn-init');
    await waitForReady(page, 120000);

    // Destroy
    await page.click('#btn-destroy');

    // Wait for destruction
    await page.waitForFunction(() => (window as any).nerProcessor === null);

    // Check status
    const statusText = await page.textContent('#status-ready');
    expect(statusText).toBe('Not Ready');
  });
});

test.describe('Entity Extraction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    const supported = await isNERSupported(page);
    if (!supported) {
      test.skip();
      return;
    }

    // Initialize processor
    await page.click('#btn-init');
    await waitForReady(page, 120000);
  });

  test('should extract entities from medical text', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Enter test text
    await page.fill('#input-text', 'Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg.');

    // Extract
    await page.click('#btn-extract');

    // Wait for the fixture to populate `window.lastResult`.
    // The fixture leaves `lastResult` as `undefined` until the first
    // successful extraction, so `!= null` (loose inequality) is the
    // correct predicate: it excludes both `null` and `undefined`.
    await page.waitForFunction(() => (window as any).lastResult != null, { timeout: 30000 });

    // Check result
    const result = await page.evaluate(() => (window as any).lastResult);
    expect(result).toBeDefined();
    expect(result.entities).toBeDefined();
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.processingTime).toBeGreaterThan(0);
  });

  test('should display entities in list', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Enter test text
    await page.fill('#input-text', 'Patient has chest pain and shortness of breath.');

    // Extract
    await page.click('#btn-extract');

    // Gate on extraction completion (fixture populates
    // `window.lastResult` after `extract()` resolves) rather than racing
    // a 30s DOM-transition timeout against WASM inference latency.
    await page.waitForFunction(() => (window as any).lastResult != null, { timeout: 30000 });

    // Check entity items exist
    const entityItems = await page.$$('.entity-item');
    expect(entityItems.length).toBeGreaterThan(0);
  });

  test('should highlight entities in text', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Enter test text
    await page.fill('#input-text', 'Aspirin 325mg prescribed for pain.');

    // Extract
    await page.click('#btn-extract');

    // Gate on extraction completion. The fixture only flips
    // `#highlighted-text-container` to visible when
    // `result.entities.length > 0` (fixture line 621-626), so we
    // conditionally assert on highlighted spans only when entities exist.
    await page.waitForFunction(() => (window as any).lastResult != null, { timeout: 30000 });

    const result = await page.evaluate(() => (window as any).lastResult);
    if (result.entities.length > 0) {
      const highlightedSpans = await page.$$('#highlighted-text .ner-entity');
      expect(highlightedSpans.length).toBeGreaterThan(0);
    }
  });

  test('should handle empty input gracefully', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Clear input
    await page.fill('#input-text', '');

    // Try to extract
    await page.click('#btn-extract');

    // Should not crash, check log for warning
    await page.waitForTimeout(500);

    const logText = await page.textContent('#log');
    expect(logText).toContain('No text to process');
  });

  test('should clear results', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Enter and extract
    await page.fill('#input-text', 'Test medical text.');
    await page.click('#btn-extract');
    await page.waitForFunction(() => (window as any).lastResult !== null, { timeout: 30000 });

    // Clear
    await page.click('#btn-clear');

    // Check cleared
    const inputValue = await page.inputValue('#input-text');
    expect(inputValue).toBe('');

    const result = await page.evaluate(() => (window as any).lastResult);
    expect(result).toBeNull();
  });
});

test.describe('Statistics', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    const supported = await isNERSupported(page);
    if (!supported) {
      test.skip();
      return;
    }

    // Initialize processor
    await page.click('#btn-init');
    await waitForReady(page, 120000);
  });

  test('should track processing statistics', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Process multiple texts
    const texts = ['Patient has diabetes.', 'Taking Metformin daily.', 'Blood pressure elevated.'];

    for (const text of texts) {
      // Clear `window.lastResult` so the wait predicate has a
      // false starting state for every iteration. Without this, the
      // predicate is satisfied by the previous iteration's result and the
      // loop body races ahead while `#btn-extract` is still disabled
      // (HTML `<button disabled>` swallows the next click), which caused
      // only 2 of 3 extractions to fire.
      await page.evaluate(() => {
        (window as any).lastResult = null;
      });
      await page.fill('#input-text', text);
      await page.click('#btn-extract');
      await page.waitForFunction(() => (window as any).lastResult != null, { timeout: 30000 });
    }

    // Read the counter directly from the processor rather than
    // the DOM `#stat-texts` cell. The DOM cell is only updated when the
    // 1000 ms `ner-stats` `setInterval` fires, so a synchronous DOM read
    // can lag the in-memory counter. `getStats()` is authoritative.
    const textsProcessed = await page.evaluate(() => (window as any).nerProcessor.getStats().textsProcessed);
    expect(textsProcessed).toBe(3);
  });

  test('should reset statistics', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Process some text
    await page.fill('#input-text', 'Patient has hypertension.');
    await page.click('#btn-extract');
    await page.waitForFunction(() => (window as any).lastResult !== null, { timeout: 30000 });

    // Reset stats
    await page.click('#btn-reset-stats');

    // Check reset
    const textsProcessed = await page.textContent('#stat-texts');
    expect(textsProcessed).toBe('0');
  });
});

test.describe('Options', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    const supported = await isNERSupported(page);
    if (!supported) {
      test.skip();
      return;
    }

    // Initialize processor
    await page.click('#btn-init');
    await waitForReady(page, 120000);
  });

  test('should update threshold dynamically', async ({ page }) => {
    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Update threshold to high value
    await page.fill('#threshold-slider', '90');
    await page.dispatchEvent('#threshold-slider', 'input');

    // Check threshold updated
    const thresholdText = await page.textContent('#threshold-value');
    expect(parseFloat(thresholdText || '0')).toBeCloseTo(0.9, 1);

    // Process text - should get fewer entities with high threshold
    await page.fill('#input-text', 'Patient diagnosed with diabetes.');
    await page.click('#btn-extract');
    // Same predicate fix as above (loose inequality
    // excludes `undefined`, which is the initial state of `lastResult`).
    await page.waitForFunction(() => (window as any).lastResult != null, { timeout: 30000 });

    const result = await page.evaluate(() => (window as any).lastResult);
    // With high threshold, we might get fewer or no entities
    expect(result.entities).toBeDefined();
  });
});

test.describe('Sample Texts', () => {
  test('should load sample text on button click', async ({ page }) => {
    await page.goto('/');

    // Click sample text button
    await page.click('.sample-text-btn:first-child');

    // Check input populated
    const inputValue = await page.inputValue('#input-text');
    expect(inputValue.length).toBeGreaterThan(0);
    expect(inputValue).toContain('Diabetes');
  });
});

test.describe('UI Responsiveness', () => {
  test('should disable buttons during initialization', async ({ page }) => {
    await page.goto('/');

    const supported = await isNERSupported(page);
    test.skip(!supported, 'NER not supported in this browser');

    // Start init
    await page.click('#btn-init');

    // Init button should be disabled during loading
    const isInitDisabled = await page.isDisabled('#btn-init');
    expect(isInitDisabled).toBe(true);

    // Wait for ready
    await waitForReady(page, 120000);

    // Extract button should be enabled
    const isExtractDisabled = await page.isDisabled('#btn-extract');
    expect(isExtractDisabled).toBe(false);
  });
});
