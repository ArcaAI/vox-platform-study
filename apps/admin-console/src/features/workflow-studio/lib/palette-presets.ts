/**
 * TASK-1036 §8.4 item 3 / OD-18 — palette PRESETS: a registry node type with a ready-made config.
 *
 * Merge: fan-in into a single-value input is refused (OD-18), so combining two results is an
 * explicit step. The Merge preset is a `core.data` step whose one input `in` is bound as an
 * ordered coalesce (`{ firstOf: [...] }`, Q1) — connect a second producer into it and the canvas
 * offers "Use first available" — and whose mappings pass that value through as `value` (and as
 * `text` when it is text), so a later step reads `nodes.<merge>.outputs.text` / `.data.value`.
 */
export interface PalettePreset {
  key: string;
  /** The registry type the preset instantiates. */
  type: string;
  label: string;
  summary: string;
  config: Record<string, unknown>;
}

export const MERGE_PRESET: PalettePreset = {
  key: 'merge',
  type: 'core.data',
  label: 'Merge',
  summary: 'Takes the first available result from several earlier steps. Link each one in, then choose “Use first available”.',
  config: {
    label: 'Merge',
    mappings: [
      { from: 'in', to: 'value' },
      { from: 'in', to: 'text' },
    ],
  },
};

export const PALETTE_PRESETS: readonly PalettePreset[] = [MERGE_PRESET];

export function presetByKey(key: string | null | undefined): PalettePreset | undefined {
  return PALETTE_PRESETS.find((preset) => preset.key === key);
}
