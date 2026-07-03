import { describe, expect, it } from 'vitest';
import { COLOR_RAMPS, RADIUS_SCALE, SEMANTIC_ROLES, SHOWCASE_SECTIONS, SPACING_SCALE, STATUS_GRAMMAR, TYPE_SCALE } from '../tokens';

describe('components-library tokens (TASK-404 · 00 Foundations / TASK-371 pillars)', () => {
  it('exposes the six semantic role cards, each referencing a CSS token pair', () => {
    expect(SEMANTIC_ROLES.map((r) => r.id)).toEqual(['primary', 'ai', 'hope', 'success', 'warning', 'destructive']);
    for (const role of SEMANTIC_ROLES) {
      expect(role.token).toMatch(/^--[a-z-]+$/);
      expect(role.bg).toBe(`var(${role.token})`);
      expect(role.fg).toBe(`var(${role.token}-foreground)`);
      expect(role.usage.length).toBeGreaterThan(0);
    }
  });

  it('ships the five foundation ramps with ascending, var-referenced steps', () => {
    expect(COLOR_RAMPS.map((r) => r.name)).toEqual(['teal', 'indigo', 'saffron', 'green', 'slate']);
    for (const ramp of COLOR_RAMPS) {
      expect(ramp.steps.length).toBeGreaterThanOrEqual(10);
      const numbers = ramp.steps.map((s) => s.step);
      expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
      for (const s of ramp.steps) expect(s.value).toBe(`var(--${ramp.name}-${s.step})`);
    }
  });

  it('type scale runs Display 30 → Caption 12 (pillar 2 ramp)', () => {
    expect(TYPE_SCALE.map((t) => t.px)).toEqual([30, 24, 20, 16, 14, 13, 12]);
    expect(TYPE_SCALE[0].name).toBe('Display');
    expect(TYPE_SCALE[TYPE_SCALE.length - 1].name).toBe('Caption');
  });

  it('radius scale references the --radius token family (pillar 4)', () => {
    expect(RADIUS_SCALE.map((r) => r.name)).toEqual(['sm', 'md', 'lg', 'xl']);
    for (const r of RADIUS_SCALE) expect(r.value).toBe(`var(--radius-${r.name})`);
  });

  it('spacing scale is the ascending 8-pt rhythm (pillar 3)', () => {
    expect(SPACING_SCALE).toEqual([2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
  });

  it('status grammar pairs every role with a text label (never color-only)', () => {
    expect(STATUS_GRAMMAR.map((s) => s.role)).toEqual(['success', 'warning', 'destructive', 'info', 'neutral']);
    for (const s of STATUS_GRAMMAR) expect(s.label.length).toBeGreaterThan(0);
  });

  it('declares the six anchored showcase sections with unique ids', () => {
    expect(SHOWCASE_SECTIONS).toHaveLength(6);
    expect(new Set(SHOWCASE_SECTIONS.map((s) => s.id)).size).toBe(6);
    for (const s of SHOWCASE_SECTIONS) {
      expect(s.id).toMatch(/^[a-z-]+$/);
      expect(s.title.length).toBeGreaterThan(0);
    }
  });
});
