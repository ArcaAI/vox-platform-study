/**
 * Shared axe gate (rule 11 §11): every screen spec scans its default state in
 * BOTH themes with zero WCAG 2.2 AA violations, following login-a11y.spec.ts.
 *
 * Plus one check axe does NOT provide — see `expectDistinctControlNames`.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * KNOWN duplicates, as `pathname-prefix::accessible name`.
 *
 * These are NOT judged acceptable — they are a recorded backlog. This guard was
 * added after the "Clear filters" defect and immediately found eleven more, which
 * is more than that fix's scope could absorb. Allowlisting them makes the current
 * state explicit and blocks NEW ones, rather than leaving the check unenforced.
 *
 * Entries are path-scoped so exempting "All" on one screen does not silently
 * exempt it everywhere. A failure prints the exact entry to paste here — but
 * prefer fixing the page: extend one control's name so it still CONTAINS its
 * visible label (WCAG 2.5.3), the way "Clear filters and show all rows" does.
 */
const KNOWN_DUPLICATES: readonly string[] = [
  // Two paginated grids on one screen; both paginations name their controls identically.
  '/harness/observability::Rows per page',
  '/harness/observability::Go to previous page',
  '/harness/observability::Go to next page',
  '/rate-limits::Rows per page',
  '/rate-limits::Go to previous page',
  '/rate-limits::Go to next page',
  // A header/primary action repeated as an empty-state or row action.
  '/dna-writing-styles::Generate report',
  '/workflow-studio::New definition',
  '/storage::Upload files',
  '/users::Reset password',
  '/tenants::Copy tenant key',
  '/playground::Generate my style',
  // Facet chips: two filter groups each offering "All".
  '/workflow-runs::All',
  // The bucket name appears as both a breadcrumb link and a list entry.
  '/storage::e2e-test-bucket',
];

/**
 * Controls inside a REPEATED structure legitimately share a name — a row's
 * "Open menu" is disambiguated by the row it is in, which a screen reader
 * announces. Only page-level peers are ambiguous.
 *
 * The container only disambiguates when there is MORE THAN ONE of it. A single
 * row or list item is not a repetition — and this is not hypothetical: the data
 * grid renders its EMPTY state inside a lone `<div role="row">`, and the original
 * "Clear filters" defect hid behind exactly that in the first two cuts of this
 * guard. Sibling count, not tag name, is what makes a structure repeated.
 */
const REPEATED_CONTAINERS = '[data-slot="data-grid-row"], tr, [role="row"], [role="option"], li';

/**
 * Fails when two VISIBLE, page-level controls share one accessible name.
 *
 * WHY THIS EXISTS. axe has no rule for it, so it went unnoticed until three
 * unrelated e2e specs (consultations, dna-writing-styles, rbac-policies) tripped
 * Playwright strict mode on the same locator. Three specs failing the same way
 * was the tell: the PAGE was ambiguous, not the tests. On a filtered grid with an
 * empty state, three buttons carried the name "Clear filters", so a screen-reader
 * user tabbing through heard it three times with nothing to tell them apart.
 *
 * The remedy is not to rename one control away from its visible label — WCAG
 * 2.5.3 (Label in Name) requires the accessible name to CONTAIN the visible text,
 * so a speech-input user can say what they see. Extend it instead:
 * "Clear filters" -> "Clear filters and show all rows".
 */
export async function expectDistinctControlNames(page: Page): Promise<void> {
  const duplicates = await page.evaluate(
    ({ repeatedSelector, allowed }) => {
      const counts = new Map<string, number>();
      for (const element of document.querySelectorAll('button, a[href], [role="button"], [role="link"]')) {
        // Hidden copies (a mobile variant behind a breakpoint, a closed popover)
        // are not peers the user can reach, so they are not ambiguous.
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const container = element.closest(repeatedSelector);
        if (container?.parentElement) {
          const peers = container.parentElement.querySelectorAll(`:scope > ${container.tagName.toLowerCase()}`).length;
          if (peers > 1) continue;
        }

        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        if (allowed.some((entry) => { const [prefix, allowedName] = entry.split('::'); return allowedName === name && location.pathname.startsWith(prefix); })) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts]
        .filter(([, count]) => count > 1)
        .map(([name, count]) => `${count}x "${name}"   (allowlist entry: '${location.pathname}::${name}')`);
    },
    { repeatedSelector: REPEATED_CONTAINERS, allowed: [...KNOWN_DUPLICATES] },
  );

  expect(
    duplicates,
    `Two or more page-level controls share one accessible name:\n  ${duplicates.join('\n  ')}\n\n` +
      'A screen-reader user hears the same label with no way to tell the controls apart.\n' +
      'Extend the names rather than replacing them — WCAG 2.5.3 requires the accessible\n' +
      'name to contain the visible label (e.g. "Save" -> "Save and close").',
  ).toEqual([]);
}

export async function expectNoA11yViolations(page: Page): Promise<void> {
  // Jump any in-flight CSS transitions to their end state (e.g. a button
  // re-enabling as data lands animates opacity 0.5 -> 1; axe would sample
  // the transient color and report a phantom contrast failure).
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // Surface the full finding in the failure output, not just a count.
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  // Ride along on every existing axe call site rather than adding a parallel
  // traversal: ~79 screen scans across both themes already run this helper.
  await expectDistinctControlNames(page);
}
