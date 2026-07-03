/**
 * TASK-404 — `01 · Components` design-system showcase model (P2-2).
 *
 * Pure data for the `/components` reference page, grounded in the TASK-371
 * foundations frame (`00 · Foundations`, §5.1) and the five design-system
 * pillars (§3). Every color is a token *reference* (`var(--…)`) resolved by
 * `@arcaai/ui` `globals.css` — no hex literals, so dark mode swaps for free.
 */

/** One semantic role card (foundations frame: token + on-color "Aa" + usage). */
export interface SemanticRole {
  id: string;
  name: string;
  /** Root CSS custom property, e.g. `--primary` (its `-foreground` pair is implied). */
  token: string;
  /** CSS background value (`var(<token>)`). */
  bg: string;
  /** CSS on-color value (`var(<token>-foreground)`). */
  fg: string;
  usage: string;
}

function role(id: string, name: string, usage: string): SemanticRole {
  const token = `--${id}`;
  return { id, name, token, bg: `var(${token})`, fg: `var(${token}-foreground)`, usage };
}

/** Pillar 1 — the six brand/semantic roles (frame order). */
export const SEMANTIC_ROLES: SemanticRole[] = [
  role('primary', 'Primary', 'Trust + healing + clinical calm — primary actions, focus ring'),
  role('ai', 'AI accent', 'Intelligence — AI/agent surfaces, model badges'),
  role('hope', 'Hope highlight', 'Hope/dawn light — highlights, brand moments'),
  role('success', 'Success / healthy', 'Compassion & healing — healthy status, confirmations'),
  role('warning', 'Warning', 'Caution — degraded status, drafts'),
  role('destructive', 'Destructive', 'Archive/revoke — calm, not alarmist'),
];

export interface RampStep {
  step: number;
  /** CSS value (`var(--<ramp>-<step>)`). */
  value: string;
}

export interface ColorRamp {
  name: string;
  steps: RampStep[];
}

function ramp(name: string, steps: number[]): ColorRamp {
  return { name, steps: steps.map((step) => ({ step, value: `var(--${name}-${step})` })) };
}

const FULL_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Pillar 1 — the foundation ramps as they exist in `globals.css` (green has no 950; slate adds 0). */
export const COLOR_RAMPS: ColorRamp[] = [
  ramp('teal', FULL_STEPS),
  ramp('indigo', FULL_STEPS),
  ramp('saffron', FULL_STEPS),
  ramp('green', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
  ramp('slate', [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
];

export interface TypeStep {
  name: string;
  px: number;
  /** Tailwind classes rendering this step. */
  className: string;
  sample: string;
}

/** Pillar 2 — the type ramp (Display 30 → Caption 12, Inter, body line-height 1.5). */
export const TYPE_SCALE: TypeStep[] = [
  { name: 'Display', px: 30, className: 'text-3xl font-semibold tracking-tight', sample: 'Clinical calm at a glance' },
  { name: 'H1', px: 24, className: 'text-2xl font-semibold tracking-tight', sample: 'Tenant overview' },
  { name: 'H2', px: 20, className: 'text-xl font-semibold', sample: 'Service monitoring' },
  { name: 'H3', px: 16, className: 'text-base font-semibold', sample: 'Consultation detail' },
  {
    name: 'Body',
    px: 14,
    className: 'text-sm leading-normal',
    sample: 'HOPE keeps clinicians present with patients while AI handles the paperwork.',
  },
  { name: 'Small', px: 13, className: 'text-[13px] text-muted-foreground', sample: 'Secondary description text' },
  { name: 'Caption', px: 12, className: 'text-xs text-muted-foreground', sample: 'Refreshed 30 s ago' },
];

export interface RadiusStep {
  name: string;
  /** CSS value (`var(--radius-<name>)`). */
  value: string;
  usage: string;
}

/** Pillar 4 — radius scale off the 10px base token (buttons 8 / cards-inputs 10 / pills full). */
export const RADIUS_SCALE: RadiusStep[] = [
  { name: 'sm', value: 'var(--radius-sm)', usage: 'Chips, small controls' },
  { name: 'md', value: 'var(--radius-md)', usage: 'Buttons' },
  { name: 'lg', value: 'var(--radius-lg)', usage: 'Inputs, cards' },
  { name: 'xl', value: 'var(--radius-xl)', usage: 'Overlays, feature cards' },
];

/** Pillar 3 — the 8-pt rhythm on a 4-px base. */
export const SPACING_SCALE: number[] = [2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64];

export interface StatusExample {
  role: 'success' | 'warning' | 'destructive' | 'info' | 'neutral';
  label: string;
  meaning: string;
}

/** Status grammar — dot + text label, never color-only (a11y pillar). */
export const STATUS_GRAMMAR: StatusExample[] = [
  { role: 'success', label: 'Healthy', meaning: 'Service up, checks passing' },
  { role: 'warning', label: 'Degraded', meaning: 'Partial failures, retrying' },
  { role: 'destructive', label: 'Unhealthy', meaning: 'Down or failing checks' },
  { role: 'info', label: 'Checking', meaning: 'Probe in flight' },
  { role: 'neutral', label: 'Unknown', meaning: 'Not reporting' },
];

export interface ShowcaseSection {
  id: string;
  title: string;
  description: string;
}

/** Page anchor map (in render order). */
export const SHOWCASE_SECTIONS: ShowcaseSection[] = [
  { id: 'tokens', title: 'Color tokens', description: 'Semantic roles and the foundation ramps behind them' },
  { id: 'typography', title: 'Typography', description: 'Inter ramp, tabular numerals, JetBrains Mono' },
  { id: 'shape', title: 'Shape & spacing', description: 'Radius scale, 8-pt rhythm, border-first depth' },
  { id: 'status', title: 'Status grammar', description: 'Dot + label pairs — status is never color-only' },
  { id: 'primitives', title: 'Primitives', description: 'Core @arcaai/ui controls and their states' },
  { id: 'metrics', title: 'Metrics primitives', description: 'TASK-377 shared reporting components' },
];
