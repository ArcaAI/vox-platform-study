/**
 * Shared axe gate (rule 11 §11): every screen spec scans its default state in
 * BOTH themes with zero WCAG 2.2 AA violations, following login-a11y.spec.ts.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function expectNoA11yViolations(page: Page): Promise<void> {
  // Jump any in-flight CSS transitions to their end state (e.g. a button
  // re-enabling as data lands animates opacity 0.5 -> 1; axe would sample
  // the transient color and report a phantom contrast failure).
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // Surface the full finding in the failure output, not just a count.
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}
