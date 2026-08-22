import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TASK-787 Phase 2 · THE contrast gate.
 *
 * Why this file exists at all: before it, a palette change passed CI while
 * silently regressing contrast across every screen. The 67 `vitest-axe` suites
 * run in happy-dom, where axe SKIPS `color-contrast` outright (the repo says so
 * itself in `src/components/__tests__/helpers/axe.ts:9-12`); the 40 real-browser
 * `@axe-core/playwright` specs were wired to no CI job; and the only two genuine
 * contrast tests lived in a `when: never`, `allow_failure: true` job. The single
 * job that would have failed on a bad palette failed for an unrelated reason
 * (`accent-tokens.vitest.ts`, deleted under J-4).
 *
 * So this gate is deliberately NOT a rendering test. It reads `globals.css`,
 * resolves every semantic role through its `var()` chain to a concrete hex in
 * BOTH themes, and computes the WCAG 2.x ratio arithmetically. That makes it
 * browser-independent — it runs in `test-sdk` on a plain node runner — and it
 * cannot be out-run by a screen that simply does not happen to render the
 * offending pair, which is the failure mode of every axe-based check here.
 *
 * It asserts the TOKEN CONTRACT, not the painted pixel. A component that
 * composites `text-foreground/60` over a surface defeats it; that is what the
 * Playwright-CT contrast tests in `src/components/__tests__/shadcn/` are for.
 * The two are complements, not substitutes.
 *
 * Vitest runs each package's suite with cwd = the package root.
 */
const CSS_PATH = join(process.cwd(), 'src/styles/globals.css');
const css = readFileSync(CSS_PATH, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Parse: pull the two TOP-LEVEL token blocks out of globals.css.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Brace-matched extraction of a top-level rule body. Anchored to column 0 (`^`
 * with the `m` flag) on purpose: `globals.css` also declares a `:root` INSIDE
 * `@media (prefers-reduced-motion: reduce)`, indented, which re-declares the
 * motion durations. A non-anchored match would pick whichever came first and
 * silently read the wrong block.
 */
function ruleBody(selector: string): string {
  const anchored = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
  const match = anchored.exec(css);
  if (!match) throw new Error(`no top-level \`${selector}\` block in ${CSS_PATH}`);
  let depth = 0;
  const open = css.indexOf('{', match.index);
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after \`${selector}\``);
}

function customProperties(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Comments are stripped first — several token comments contain literal hex
  // values and `--token:` prose that would otherwise parse as declarations.
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const lightVars = customProperties(ruleBody(':root'));
const darkVars = { ...lightVars, ...customProperties(ruleBody('.dark')) };
const THEMES = { light: lightVars, dark: darkVars } as const;
type Theme = keyof typeof THEMES;

/**
 * Follow `var()` indirection to a literal. Roles are declared as
 * `--input: var(--neutral-520)` and the raw ramp holds the hex, so a resolver
 * that stopped at the first hop would compare the string "var(--neutral-520)"
 * against itself and pass everything.
 */
function resolve(token: string, vars: Record<string, string>): string {
  let value: string | undefined = vars[token];
  const seen = new Set<string>([token]);
  while (value !== undefined && /^var\(\s*--[\w-]+\s*\)$/.test(value)) {
    const next: string = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)![1];
    if (seen.has(next)) throw new Error(`circular var() chain at ${next}`);
    seen.add(next);
    value = vars[next];
  }
  if (value === undefined) throw new Error(`\`${token}\` is not declared (or resolves to nothing)`);
  return value.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// WCAG 2.x relative luminance + contrast ratio.
// ─────────────────────────────────────────────────────────────────────────────

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  // Strict on purpose. An oklch()/rgba() value would parse into plausible-looking
  // numbers under a laxer regex and yield a silently wrong — usually passing — ratio.
  if (!m) throw new Error(`expected a 6- or 8-digit hex colour, got "${hex}"`);
  if (m[2]) throw new Error(`"${hex}" carries alpha; contrast against a translucent value is undefined here`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
};

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// The pair table.
// ─────────────────────────────────────────────────────────────────────────────

/** `text` carries the 1.4.3 floor (4.5:1); `ui` carries the 1.4.11 floor (3:1). */
type Kind = 'text' | 'ui';
interface Pair {
  fg: string;
  bg: string;
  kind: Kind;
}

const FLOOR: Record<Kind, number> = { text: 4.5, ui: 3 };

const pair = (fg: string, bg: string, kind: Kind): Pair => ({ fg, bg, kind });
const cross = (fgs: string[], bgs: string[], kind: Kind) => fgs.flatMap((fg) => bgs.map((bg) => pair(fg, bg, kind)));

const PAIRS: Pair[] = [
  // 1. Every `*-foreground` on the surface or fill it names. This is the pair a
  //    component actually paints when it writes `bg-secondary text-secondary-foreground`.
  ...(
    [
      ['foreground', 'background'],
      ['card-foreground', 'card'],
      ['popover-foreground', 'popover'],
      ['primary-foreground', 'primary'],
      ['secondary-foreground', 'secondary'],
      ['muted-foreground', 'muted'],
      ['accent-foreground', 'accent'],
      // The J-2 hover steps: --secondary and --accent deliberately collide on one
      // sunken fill, so the hover step is the only thing keeping them legible as
      // controls — it has to clear the floor too, not just the resting fill.
      ['secondary-foreground', 'secondary-hover'],
      ['accent-foreground', 'accent-hover'],
      ['destructive-foreground', 'destructive'],
      ['ai-foreground', 'ai'],
      ['hope-foreground', 'hope'],
      ['success-foreground', 'success'],
      ['warning-foreground', 'warning'],
      ['info-foreground', 'info'],
      ['sidebar-foreground', 'sidebar'],
      ['sidebar-primary-foreground', 'sidebar-primary'],
      ['sidebar-accent-foreground', 'sidebar-accent'],
    ] as const
  ).map(([fg, bg]) => pair(fg, bg, 'text')),

  // 2. Secondary and tertiary text on every surface either can land on. This is
  //    the EX-04 correction's whole point: #767676 clears 4.5:1 on #ffffff and
  //    fails on #fafafa, so calibrating against one surface is not enough.
  ...cross(['muted-foreground', 'muted-foreground-subtle'], ['background', 'card', 'muted', 'secondary'], 'text'),

  // 3. Body ink on every surface it can be placed over.
  ...cross(
    ['foreground'],
    ['card', 'popover', 'muted', 'secondary', 'accent', 'secondary-hover', 'accent-hover', 'sidebar'],
    'text',
  ),

  // 4. Non-text UI boundaries. --ring is the focus indicator (1.4.11, and the
  //    EX-01 fix this ticket lands); --input is a form-field boundary, which is
  //    a UI component boundary and owes 3:1 — that is precisely why Phase 1
  //    split it out of --border.
  ...cross(['ring', 'sidebar-ring', 'input', 'border', 'sidebar-border'], ['background', 'card', 'sidebar'], 'ui'),

  // 5. Data series. A chart mark is non-text, so 3:1 — but it must hold on BOTH
  //    the canvas and the raised card, because charts live inside cards.
  ...cross(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'], ['background', 'card'], 'ui'),

  // 6. The `*-strong` text-on-tint inks. These exist because the matching fill
  //    value does not clear 4.5:1 as text; if a `*-strong` step ever stopped
  //    clearing it, the token would be pure decoration.
  ...cross(
    ['primary-strong', 'success-strong', 'warning-strong', 'destructive-strong', 'hope-strong', 'link'],
    ['background', 'card'],
    'text',
  ),

  // 7. Role colours used AS TEXT rather than as a fill. Two of these are
  //    adjudicated exemptions (see below) — the rest are enforced, and that is
  //    the point: the exemption list has to be short and named.
  ...cross(['destructive', 'success', 'warning', 'info', 'ai', 'hope', 'primary'], ['background', 'card'], 'text'),

  // 8. The sidebar active-item fill against the sidebar it sits on (J-11).
  pair('sidebar-accent', 'sidebar', 'ui'),
]
  // The groups above overlap by design — `muted-foreground on muted` is both a
  // matching-foreground pair and a secondary-ink pair. Dedupe so a failure is
  // reported once rather than once per reason.
  .filter((p, i, all) => all.findIndex((q) => q.fg === p.fg && q.bg === p.bg && q.kind === p.kind) === i);

// ─────────────────────────────────────────────────────────────────────────────
// Adjudicated exemptions.
//
// Every one of these is a pair that does NOT meet its floor and is deliberately
// shipped that way. They are written down as EXPLICIT allowances with the
// measured value pinned, never as a silent omission from the table above: an
// omitted pair is indistinguishable from a forgotten one, and a pin means a
// drift in the exempt value still fails the build.
// ─────────────────────────────────────────────────────────────────────────────

interface Exemption {
  fg: string;
  bg: string;
  themes: readonly Theme[];
  /** The measured ratio at the time of adjudication. Pinned to ±0.01. */
  ratio: Partial<Record<Theme, number>>;
  why: string;
}

const EXEMPTIONS: Exemption[] = [
  // (a) DECORATIVE HAIRLINE. --border (and its sidebar twin, the same value) is
  //     a separator, not a UI component boundary, and WCAG 1.4.11 exempts purely
  //     decorative elements. The token that DOES owe 3:1 — the form-field
  //     boundary — was split out as --input in Phase 1 precisely so this
  //     exemption stays narrow. Darkening --border to 3:1 would turn every card
  //     edge into a drawn line and destroy the flat identity (J-12).
  {
    fg: 'border',
    bg: 'background',
    themes: ['light', 'dark'],
    ratio: { light: 1.2, dark: 1.25 },
    why: 'decorative hairline (WCAG 1.4.11 decorative exemption); --input carries the 3:1 duty',
  },
  {
    fg: 'border',
    bg: 'card',
    themes: ['light', 'dark'],
    ratio: { light: 1.25, dark: 1.34 },
    why: 'decorative hairline',
  },
  {
    fg: 'border',
    bg: 'sidebar',
    themes: ['light', 'dark'],
    ratio: { light: 1.25, dark: 1.34 },
    why: 'decorative hairline',
  },
  {
    fg: 'sidebar-border',
    bg: 'background',
    themes: ['light', 'dark'],
    ratio: { light: 1.2, dark: 1.25 },
    why: 'decorative hairline — same value as --border',
  },
  {
    fg: 'sidebar-border',
    bg: 'card',
    themes: ['light', 'dark'],
    ratio: { light: 1.25, dark: 1.34 },
    why: 'decorative hairline — same value as --border',
  },
  {
    fg: 'sidebar-border',
    bg: 'sidebar',
    themes: ['light', 'dark'],
    ratio: { light: 1.25, dark: 1.34 },
    why: 'decorative hairline — same value as --border',
  },

  // (b) J-11 — the sidebar active-item FILL. EX-12's own >=3:1 guardrail is
  //     unachievable with an achromatic palette on a white sidebar, so the fill
  //     is never the sole signal: font-weight 500 plus a 2px --foreground left
  //     rule are the second and third signals, and they land in TASK-788 AC-5.
  //     Until that ships, this exemption is carrying an OPEN a11y debt, not a
  //     closed decision. Do not "fix" it by darkening the fill in isolation —
  //     that changes the surface without adding a signal.
  {
    fg: 'sidebar-accent',
    bg: 'sidebar',
    themes: ['light', 'dark'],
    ratio: { light: 1.14, dark: 1.34 },
    why: 'J-11 — active-item fill is one of three signals; second/third land in TASK-788 AC-5',
  },

  // (c) FILL, NOT INK. --warning (#c08827) and --hope (#e6651b) are fill values:
  //     they are used as `bg-warning` / a chart mark / an icon glyph, where the
  //     3:1 non-text floor applies and both clear it. As 12px body text they do
  //     not clear 4.5:1, which is exactly why --warning-strong (#8a5f12, 5.40:1)
  //     and --hope-strong (#a8410c, 5.87:1) exist and are enforced above.
  //     Dark is NOT exempt: the lightened dark tints clear 4.5:1 as text and
  //     stay enforced, so a regression there still fails.
  {
    fg: 'warning',
    bg: 'background',
    themes: ['light'],
    ratio: { light: 2.96 },
    why: 'fill, not ink — --warning-strong is the text step (enforced above)',
  },
  {
    fg: 'warning',
    bg: 'card',
    themes: ['light'],
    ratio: { light: 3.09 },
    why: 'fill, not ink — --warning-strong is the text step',
  },
  {
    fg: 'hope',
    bg: 'background',
    themes: ['light'],
    ratio: { light: 3.22 },
    why: 'fill, not ink — --hope-strong is the text step (same adjudication as --warning)',
  },
  {
    fg: 'hope',
    bg: 'card',
    themes: ['light'],
    ratio: { light: 3.36 },
    why: 'fill, not ink — --hope-strong is the text step',
  },

  // (d) DARK-THEME EMPHASIS COLLAPSE. Recorded as a hard rule in globals.css:
  //     #949494 (secondary) and #8f8f8f (tertiary) sit 0.35 apart, are visually
  //     indistinguishable, and NEITHER clears 4.5:1 on the #343434
  //     --secondary/--accent fill. The resolution is a PROHIBITION, not a
  //     tolerance: in dark theme, no secondary or tertiary text on a
  //     --secondary/--accent fill — badges and chips use --foreground. The test
  //     below (`the dark-theme prohibition has a viable alternative`) asserts
  //     that the prescribed alternative actually clears the floor, so the rule
  //     is enforceable rather than merely written down.
  // muted-foreground on secondary was PROHIBITED here at 4.10:1 until the live
  // browser found it: the real-browser axe suite reported exactly this pair on
  // four screens (departments, queues, workflow-studio), so the prohibition was
  // being violated in practice rather than respected. Dark --muted-foreground
  // was a DERIVED value — the reference system ships no dark data for this pair —
  // and it was derived one step too dark. Raised #949494 -> #a0a0a0, which clears
  // 4.5:1 on every dark surface (4.76 secondary / 5.94 background / 6.38 card) and
  // widens every other pairing too. The prohibition is gone because the hazard is
  // gone; the pair is now enforced by the normal sweep above.
  {
    fg: 'muted-foreground-subtle',
    bg: 'secondary',
    themes: ['dark'],
    ratio: { dark: 3.85 },
    why: 'dark-theme emphasis collapse — the combination is PROHIBITED; use --foreground',
  },
];

const exemptionFor = (theme: Theme, p: Pair) =>
  EXEMPTIONS.find((e) => e.fg === p.fg && e.bg === p.bg && e.themes.includes(theme));

// ─────────────────────────────────────────────────────────────────────────────

describe('token contrast · globals.css', () => {
  it('parses both theme blocks off the canonical token file', () => {
    expect(Object.keys(lightVars).length).toBeGreaterThan(60);
    expect(Object.keys(darkVars).length).toBeGreaterThan(60);
    // The `.dark` block must actually override, not merely repeat, the canvas.
    expect(resolve('--background', darkVars)).not.toBe(resolve('--background', lightVars));
  });

  it('resolves every pair token through its var() chain to a concrete hex', () => {
    const dangling: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const token of new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))) {
        const value = resolve(`--${token}`, THEMES[theme]);
        // A `var()` that survived resolution means a typo'd or deleted token —
        // at paint time the declaration is simply dropped and the role inherits,
        // which no source-text grep would catch.
        if (!/^#[0-9a-f]{6}$/i.test(value)) dangling.push(`${theme} --${token} -> ${value}`);
      }
    }
    expect(dangling, 'tokens that do not resolve to a plain 6-digit hex').toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    const enforced = PAIRS.filter((p) => !exemptionFor(theme, p));

    describe(`${theme} theme`, () => {
      it(`enforces every non-exempt pair (${enforced.length} pairs)`, () => {
        const failures: string[] = [];
        for (const p of enforced) {
          const fg = resolve(`--${p.fg}`, THEMES[theme]);
          const bg = resolve(`--${p.bg}`, THEMES[theme]);
          const ratio = contrast(fg, bg);
          if (ratio < FLOOR[p.kind]) {
            failures.push(
              `--${p.fg} (${fg}) on --${p.bg} (${bg}) = ${ratio.toFixed(2)}:1, ` +
                `below the ${FLOOR[p.kind]}:1 ${p.kind === 'text' ? 'WCAG 1.4.3 text' : 'WCAG 1.4.11 non-text'} floor [${theme}]`,
            );
          }
        }
        expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
      });

      // Pinning the exempt values is what stops an exemption from becoming a
      // blind spot: the pair is allowed to sit below its floor at THIS ratio,
      // and any movement — better or worse — re-opens the adjudication.
      const pinned = EXEMPTIONS.filter((e) => e.themes.includes(theme));
      it.each(pinned.map((e) => [`--${e.fg} on --${e.bg}`, e] as const))(
        'pins the adjudicated exemption %s',
        (_label, e) => {
          const fg = resolve(`--${e.fg}`, THEMES[theme]);
          const bg = resolve(`--${e.bg}`, THEMES[theme]);
          expect(contrast(fg, bg), `${e.why}`).toBeCloseTo(e.ratio[theme]!, 2);
        },
      );
    });
  }

  it('the dark-theme prohibition has a viable alternative', () => {
    // Exemption (d) forbids secondary/tertiary ink on the dark sunken fill and
    // prescribes --foreground instead. An exemption whose prescribed alternative
    // also failed would be a dead letter, so assert the alternative holds.
    for (const fill of ['secondary', 'accent'] as const) {
      const bg = resolve(`--${fill}`, darkVars);
      const ratio = contrast(resolve('--foreground', darkVars), bg);
      expect(ratio, `--foreground on --${fill} (dark) is the prescribed badge/chip ink`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('token layer · structural invariants', () => {
  // Migrated from the deleted `accent-tokens.vitest.ts`, inverted. That file
  // asserted the three `data-accent` blocks EXIST; J-4 deleted the axis outright
  // (with --primary and --ring both resolving to the neutral ink it had nothing
  // left to vary). The invariant worth keeping is the opposite one: the axis
  // must not come back, because re-adding it would reintroduce the hue OD-1
  // retired and would fork the palette this gate measures.
  it('carries no data-accent theme axis (J-4)', () => {
    expect(css).not.toMatch(/\[data-accent[=\]]/);
  });

  // Also from the deleted file: it pinned `--primary` to the teal ramp, which is
  // retired. The durable form of that assertion is that the retired ramp is gone
  // — a stray `--teal-*` reference would resolve to nothing and silently blank
  // whichever role kept it.
  it('carries no reference to the retired --teal-* ramp (OD-1)', () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/--teal-\d/);
  });
});
