import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * · Emphasis canon guard for the admin console.
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
 * shipped a `selected ? 'text-primary font-semibold': 'font-medium'` row whose
 * two branches were pixel-identical. In this palette emphasis comes from WEIGHT
 * (400 vs 500 — the Geometry Contract allows no others), SIZE, POSITION, a
 * background fill, or a rule/indicator. Never from this token.
 *
 * The companion guard for the component library is
 * `packages/ui/src/components/__tests__/emphasis-canon.vitest.ts`, which also
 * documents why the vendored `registries/**` tree is exempt. Nothing under this
 * app is vendored, so nothing here is exempt.
 *
 * Source-text assertion (node project, no DOM needed): the thing being protected
 * is the class string an author types, and no rendering test can be written that
 * a new screen cannot out-run.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** This guard quotes the banned class in its own prose and regex; it cannot be its own offender. */
const SELF = fileURLToPath(import.meta.url);

const CODE = /\.(tsx?|css)$/;

/**
 * A `<Label>` carrying BOTH `text-sm` and `font-medium` (J-18). The primitive is
 * `text-sm ... font-normal`; a section heading is `text-sm ... font-medium`. A
 * Label that opts back into 500 is byte-identical to a heading, which is the
 * collapse J-18 fixed at the primitive. `text-xs` Labels are NOT matched — at
 * 12px and usually muted they differ from a 14px foreground heading by both size
 * and colour, and 500 aids legibility at that size.
 */
const LABEL_HEADING_COLLISION = /<Label[^>]*\btext-sm\b[^>]*\bfont-medium\b/;

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

const files = walk(SRC).filter((f) => f.path !== SELF);

describe('admin console · emphasis canon (J-17)', () => {
  it('finds the console source to check', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('never uses text-primary as an emphasis signal', () => {
    // `--primary` === `--foreground` in light and 1.03:1 in dark, so this class
    // renders as plain body ink. Emphasis comes from weight (400/500), size,
    // position, a background fill or an indicator — use `text-foreground` when
    // you mean body ink, and carry state on something that is actually visible.
    const offenders = files
      .filter((f) => TEXT_PRIMARY.test(f.source))
      .map((f) => f.path.slice(SRC.length))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('never gives a <Label> a heading weight at a heading size (J-18)', () => {
    // `Label` is `text-sm font-normal`; a section heading is `text-sm font-medium`.
    // Opting a Label back into 500 at 14px re-creates, on that surface, exactly the
    // collapse J-18 fixed at the primitive — a form label indistinguishable from the
    // card heading above it. Drop `font-medium` (the primitive's 400 is the point),
    // or if the label genuinely IS the row's title, size it instead.
    const offenders = files
      .filter((f) => LABEL_HEADING_COLLISION.test(f.source))
      .map((f) => f.path.slice(SRC.length))
      .sort();
    expect(offenders).toEqual([]);
  });
});
