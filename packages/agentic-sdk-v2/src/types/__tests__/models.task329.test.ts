/**
 * Local-model selection constants.
 *
 * `DEFAULT_AVAILABLE_STT_MODELS` is derived from `DEFAULT_STT_MODELS` so the
 * registry-selectable set and the presented (config-default) set cannot drift
 * apart again — the single source of truth for the availableModels bug fix.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_STT_MODELS, DEFAULT_AVAILABLE_STT_MODELS } from '../models';

describe('DEFAULT_AVAILABLE_STT_MODELS', () => {
  it('is derived from DEFAULT_STT_MODELS (identical ids, same order)', () => {
    expect(DEFAULT_AVAILABLE_STT_MODELS.map((m) => m.id)).toEqual(DEFAULT_STT_MODELS.map((m) => m.id));
  });

  it('exposes a display name (and optional size) per model', () => {
    for (const model of DEFAULT_AVAILABLE_STT_MODELS) {
      expect(typeof model.id).toBe('string');
      expect(typeof model.name).toBe('string');
      if (model.size !== undefined) expect(typeof model.size).toBe('string');
    }
  });
});
