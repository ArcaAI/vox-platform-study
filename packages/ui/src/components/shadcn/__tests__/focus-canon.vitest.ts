import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TASK-765 · Design-system conformance guard for the shadcn primitives.
 *
 * These are source-text assertions rather than rendered-DOM assertions on
 * purpose: the thing being protected is the CLASS STRING an author types, and
 * every regression here reintroduces itself by someone pasting an upstream
 * shadcn snippet back over a file. A rendering test would have to enumerate
 * every focusable primitive; this one cannot be out-run by a new file.
 *
 * Vitest runs each package's suite with cwd = the package root.
 */
const dir = join(process.cwd(), 'src/components/shadcn');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.tsx'))
  .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));

/** Report every offender at once — a guard that names one file per run is a slow guard. */
function offenders(pattern: RegExp) {
  return files.filter((f) => pattern.test(f.source)).map((f) => f.name);
}

describe('shadcn primitives · focus indicator canon', () => {
  it('finds the primitives to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  // ring-ring/50 measures 2.06:1 (light) / 2.67:1 (dark) against the page
  // background. WCAG 2.2 SC 1.4.11 requires 3:1. The same teal at full opacity
  // reaches 4.89:1 / 7.10:1.
  it('never draws a focus ring at 50% alpha', () => {
    expect(offenders(/ring-ring\/50/)).toEqual([]);
  });

  it('never alpha-fades any focus ring colour', () => {
    // aria-invalid:ring-destructive/20 is an error-state TINT, not a focus
    // indicator, and is deliberately left alone — hence the focus-visible anchor.
    expect(offenders(/focus-visible:ring-[a-z-]+\/\d+/)).toEqual([]);
  });

  // Tailwind v4 draws ring-* as box-shadow, and forced-colors mode does not
  // render box-shadows. `outline-hidden` keeps a transparent outline the OS can
  // force to a system colour; `outline-none` removes it, leaving Windows High
  // Contrast users with no focus indicator at all.
  it('uses outline-hidden, never outline-none', () => {
    expect(offenders(/outline-none/)).toEqual([]);
  });

  it('sizes every focus ring at the canonical 3px (ring-0 resets excepted)', () => {
    expect(offenders(/focus-visible:ring-[1-9]\d*\b/)).toEqual([]);
  });

  it('always pairs a focus ring width with an explicit ring colour', () => {
    // Without one the ring falls through to currentColor, which tracks the text
    // colour and has no contrast guarantee against the page.
    const withWidth = files.filter((f) => /focus-visible:ring-\[3px\]/.test(f.source));
    expect(withWidth.length).toBeGreaterThan(10);
    const uncoloured = withWidth
      .filter((f) => !/ring-(ring|sidebar-ring|destructive)\b/.test(f.source))
      .map((f) => f.name);
    expect(uncoloured).toEqual([]);
  });
});

describe('shadcn primitives · token conformance', () => {
  // HOPE's design tokens are HEX (--teal-600: #0f7a8b). hsl(#0f7a8b) is not a
  // valid colour, so the browser discards the whole declaration silently.
  it('never wraps a HOPE token in hsl()', () => {
    expect(offenders(/hsl\(var\(--/)).toEqual([]);
  });

  it('stacks portal surfaces on the named z-overlay step, not a literal z-50', () => {
    expect(offenders(/\bz-50\b/)).toEqual([]);
  });
});
