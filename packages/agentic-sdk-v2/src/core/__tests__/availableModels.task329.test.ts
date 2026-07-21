/**
 * availableModels single-source-of-truth regression.
 *
 * BUG: the model list *presented* to the user (`SttConfigSchema.availableModels`
 * default, surfaced as `SYSTEM_DEFAULTS.stt.availableModels`) drifted from the
 * set the registry can actually *select/load* (`DEFAULT_STT_MODELS`). The
 * registry advertised `whisper-medium` as selectable/loadable while the config
 * default (and the playground filter) only ever presented tiny/base/small.
 *
 * These tests pin the invariant: the presented set === the selectable set ===
 * the loadable set. They fail RED before `DEFAULT_STT_MODELS` is reconciled
 * with the config default.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_STT_MODELS } from '../../types/models';
import { SYSTEM_DEFAULTS } from '../ConfigSchema';
import { ModelRegistry } from '../ModelRegistry';

describe('TASK-329 P3 — availableModels single source of truth', () => {
  it('presented availableModels default equals the registry-selectable STT set', () => {
    const presentedIds = SYSTEM_DEFAULTS.stt.availableModels.map((m) => m.id).sort();
    const registryIds = DEFAULT_STT_MODELS.map((m) => m.id).sort();

    expect(presentedIds).toEqual(registryIds);
  });

  it('every presented model is loadable, and every selectable model is presented', () => {
    const registry = new ModelRegistry({}, {} as never);
    const presentedIds = new Set(SYSTEM_DEFAULTS.stt.availableModels.map((m) => m.id));

    // presented ⊆ loadable
    for (const model of SYSTEM_DEFAULTS.stt.availableModels) {
      expect(registry.getModelUrl(model.id)).toBeTruthy();
    }

    // selectable ⊆ presented (no hidden registry model that the UI never offers)
    for (const model of registry.getModelsByType('stt')) {
      expect(presentedIds.has(model.id)).toBe(true);
    }
  });
});
