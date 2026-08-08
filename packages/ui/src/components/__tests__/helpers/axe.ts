import axe from 'axe-core';
import type { Page } from '@playwright/experimental-ct-react';

/**
 * Run axe-core inside a Playwright component-test page.
 *
 * This exists as a CT helper (not a vitest/happy-dom one) because the rules
 * worth gating on here are the ones that need real layout and real computed
 * colours. `color-contrast` in particular is a no-op outside a browser: axe
 * skips it when it cannot resolve the rendered colour stack, so a jsdom or
 * happy-dom scan of the same markup reports zero violations no matter how bad
 * the palette is.
 */
export async function runAxe(page: Page, options?: { runOnly?: string[] }): Promise<axe.Result[]> {
  await page.addScriptTag({ content: axe.source });

  const violations = await page.evaluate(async (runOnly) => {
    const result = await (window as unknown as { axe: typeof axe }).axe.run(
      document.body,
      runOnly ? { runOnly } : { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } },
    );
    return result.violations;
  }, options?.runOnly);

  return violations;
}

/** Compact `file:line`-style summary so a failure names the rule and the node. */
export function formatViolations(violations: axe.Result[]): string {
  return violations.map((v) => `${v.id}: ${v.description}\n${v.nodes.map((n) => `  ${n.html}\n  ${n.failureSummary ?? ''}`).join('\n')}`).join('\n\n');
}

/** Apply the `.dark` class the way `next-themes` does, then restore on teardown. */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    // The CT harness body is transparent by default; give it the app surface so
    // axe blends against the same background the console renders on. Read the
    // token rather than hardcoding a hex, so a palette change can't silently
    // make these scans test a background the app never shows.
    document.body.style.backgroundColor = 'var(--background)';
  }, theme);
}
