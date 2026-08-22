import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TASK-787 J-17 · Emphasis canon guard for HOPE-owned `packages/ui` source.
 *
 * WHY THIS EXISTS. Under the Tatva achromatic identity `--primary` and
 * `--foreground` resolve to the SAME value in light (`var(--neutral-900)`) and
 * sit 1.03:1 apart in dark (#e8e8e8 vs #e4e4e4). `text-primary` therefore paints
 * exactly what the surrounding body text already paints: it is not an emphasis
 * signal, it is a synonym for `text-foreground` that READS like a signal.
 *
 * That is the dangerous part. A future author reaching for `text-primary` to mean
 * "selected" / "active" / "emphasised" gets a class that compiles, passes review
 * and renders nothing — which is precisely how `audio-pipelines-screen.tsx`
 * shipped a `selected ? 'text-primary font-semibold' : 'font-medium'` row whose
 * two branches were pixel-identical. In this palette emphasis comes from WEIGHT
 * (400 vs 500 — the Geometry Contract allows no others), SIZE, POSITION, a
 * background fill, or a rule/indicator. Never from this token.
 *
 * SCOPE. HOPE-owned files only. `src/**\/registries/**` is VENDORED third-party
 * code that is re-synced from upstream; sweeping it would cost a re-application
 * on every sync for zero visual change, so it is deliberately EXEMPT — see the
 * exemption assertion below, which pins that the exemption is real rather than
 * an accident of the walker.
 *
 * Source-text assertion in the style of `shadcn/__tests__/focus-canon.vitest.ts`:
 * the thing being protected is the class string an author types, and no rendering
 * test can be written that a new file cannot out-run.
 *
 * Vitest runs this package's suite with cwd = the package root.
 */

const SRC = join(process.cwd(), 'src');

/** Vendored, upstream-synced — exempt by design (see the doc block). */
const EXEMPT_SEGMENT = `${sep}registries${sep}`;

/**
 * This guard quotes the banned class in its own prose and regex, so it cannot be
 * its own offender. Resolved off cwd rather than `import.meta.url` — this package
 * type-checks as CommonJS (TS1470).
 */
const SELF = join(SRC, 'components', '__tests__', 'emphasis-canon.vitest.ts');

const CODE = /\.(tsx?|css)$/;

/** `text-primary` but NOT `text-primary-foreground` (ink ON a primary fill — a different token). */
const TEXT_PRIMARY = /text-primary(?![-\w])/;

function walk(dir: string, out: { path: string; source: string }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (CODE.test(entry.name)) {
      out.push({ path: full, source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

const all = walk(SRC);
const hopeOwned = all.filter((f) => !f.path.includes(EXEMPT_SEGMENT) && f.path !== SELF);

function offenders(files: typeof all, pattern: RegExp) {
  return files
    .filter((f) => pattern.test(f.source))
    .map((f) => relative(process.cwd(), f.path))
    .sort();
}

describe('packages/ui · emphasis canon (J-17)', () => {
  it('finds the HOPE-owned source to check', () => {
    expect(hopeOwned.length).toBeGreaterThan(300);
  });

  it('never uses text-primary as an emphasis signal in HOPE-owned code', () => {
    // `--primary` === `--foreground` in light and 1.03:1 in dark, so this class
    // renders as plain body ink. Emphasis comes from weight (400/500), size,
    // position, a background fill or an indicator — use `text-foreground` when
    // you mean body ink, and carry state on something that is actually visible.
    expect(offenders(hopeOwned, TEXT_PRIMARY)).toEqual([]);
  });

  it('leaves the vendored registries exempt rather than silently clean', () => {
    // If this ever reaches 0 the exemption has quietly become a sweep — either
    // upstream dropped the class, or someone swept vendored code and owes the
    // next upstream sync a re-application. Either way, re-read the exemption
    // before deleting it.
    const vendored = all.filter((f) => f.path.includes(EXEMPT_SEGMENT));
    expect(vendored.length).toBeGreaterThan(0);
    expect(offenders(vendored, TEXT_PRIMARY).length).toBeGreaterThan(0);
  });
});
