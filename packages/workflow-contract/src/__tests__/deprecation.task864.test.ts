/**
 * TASK-864 C1 — the deprecation window. Every node type outside the `core` palette is marked
 * `deprecated: true` with a `replacedBy` that names a live `core.*` type; `compile()` still
 * accepts the old types for the window (release +2) and the Studio hides them from the rail.
 */
import { describe, expect, it } from 'vitest';
import { CORE_NODE_TYPES, CORE_PALETTE_KEY, WORKFLOW_NODE_REGISTRY, isDeprecatedNodeType } from '../node-registry';

const entries = Object.values(WORKFLOW_NODE_REGISTRY);
const core = new Set(CORE_NODE_TYPES);

describe('deprecation window (C1)', () => {
  it('every non-core entry is deprecated and names a core replacement', () => {
    const undeprecated = entries.filter((d) => !core.has(d.key) && d.deprecated !== true).map((d) => d.key);
    expect(undeprecated).toEqual([]);
    const badTarget = entries.filter((d) => d.deprecated && !core.has(d.replacedBy ?? '')).map((d) => `${d.key}->${d.replacedBy}`);
    expect(badTarget).toEqual([]);
  });

  it('no core entry is deprecated', () => {
    expect(entries.filter((d) => d.paletteKey === CORE_PALETTE_KEY && d.deprecated).map((d) => d.key)).toEqual([]);
    expect(core.size).toBe(11);
  });

  it('isDeprecatedNodeType follows the flag and is false for unknown types', () => {
    expect(isDeprecatedNodeType('consultation.consentGate')).toBe(true);
    expect(isDeprecatedNodeType('core.start')).toBe(true);
    expect(isDeprecatedNodeType('core.trigger')).toBe(false);
    expect(isDeprecatedNodeType('does.not.exist')).toBe(false);
  });

  it('the 58 legacy types (four palettes + the palette-less bookends and guards) are all covered', () => {
    expect(entries.filter((d) => d.deprecated).length).toBe(58);
  });
});
