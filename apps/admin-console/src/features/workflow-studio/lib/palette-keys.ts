/**
 * TASK-890 black-box J4-F7 — the palette keys a definition may target.
 *
 * The set is CODE-OWNED (the node registry declares every node type's `paletteKey`), so it is
 * derivable rather than typed by hand. `core` leads — it is the one authoring vocabulary
 * (TASK-864) — and the rest are alphabetical.
 *
 * A palette every one of whose node types is deprecated is MARKED, not hidden: definitions that
 * already target it still exist and still have to be readable, so an author needs to see what it
 * is; a palette with even one live type is a normal choice. Palette-agnostic (`paletteKey: null`)
 * utility types belong to no palette at all and contribute nothing.
 */
import type { WorkflowNodeDescriptor } from '../api/types';

/** The one authoring vocabulary — always first, whatever the registry order (mirrors the rail). */
const CORE_PALETTE_KEY = 'core';

export interface PaletteKeyOption {
  key: string;
  /** Every node type in this palette is deprecated. */
  deprecated: boolean;
}

export function paletteKeyOptions(descriptors: readonly WorkflowNodeDescriptor[]): PaletteKeyOption[] {
  const live = new Map<string, boolean>();
  for (const descriptor of descriptors) {
    const key = descriptor.paletteKey;
    if (!key) continue;
    live.set(key, (live.get(key) ?? false) || descriptor.deprecated !== true);
  }
  return [...live.entries()]
    .map(([key, hasLive]) => ({ key, deprecated: !hasLive }))
    .sort((a, b) => Number(b.key === CORE_PALETTE_KEY) - Number(a.key === CORE_PALETTE_KEY) || a.key.localeCompare(b.key));
}
