/**
 * TASK-1001 OD-10 — the platform DEFAULT for decode-time repetition pressure.
 *
 * A 2B model at temperature 0 wrote clinical notes that repeat sentences, and the owner kept that
 * model (OD-7). `frequencyPenalty` / `presencePenalty` already exist on an Agent's
 * `parameters.generation`, but a PUBLISHED Agent's parameters cannot be updated (a DB trigger
 * refuses it), so the value that fixes the fleet has to be a RUNTIME setting. These two keys are
 * that setting: the last fallback `apps/text` applies to a request that states no penalty and
 * whose Agent authored none.
 *
 * What is pinned, because each one fails SILENTLY when it drifts:
 *  1. The exact keys. A sibling lane (`apps/text`) reads them BY NAME off the effective-config
 *     `generation` group; a renamed key is a knob nobody can ever set.
 *  2. The same channel as `topP`: `global-kv`, SYSTEM-only, `consumedBy: ['text']`.
 *  3. Default `0` — neutral. Registering the keys must change ZERO provider requests until an
 *     admin writes a value.
 *  4. The range the Agent contract declares for the same knob (`GENERATION_PROPERTY`), refused
 *     rather than clamped, and read off the CONTRACT here so the two cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '@arcaai/workflow-contract';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { TEXT_GENERATION_DEFAULTS, TEXT_GENERATION_SETTINGS } from '../descriptors/text-generation.descriptors';

const PENALTY_KEYS = ['text.generation.frequencyPenalty', 'text.generation.presencePenalty'] as const;

/** `parameters.generation.<name>` as the Agent contract declares it. */
function contractBound(name: 'frequencyPenalty' | 'presencePenalty'): { minimum: number; maximum: number } {
  const parameters = AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION as unknown as {
    properties: { generation: { properties: Record<string, { minimum: number; maximum: number }> } };
  };
  return parameters.properties.generation.properties[name];
}

const contractNameOf = (key: (typeof PENALTY_KEYS)[number]) => key.replace('text.generation.', '') as 'frequencyPenalty' | 'presencePenalty';

describe('TASK-1001 — text.generation penalty descriptors', () => {
  it('registers both keys alongside the existing generation profile', () => {
    expect(Object.keys(TEXT_GENERATION_DEFAULTS)).toEqual([
      'text.generation.temperature',
      'text.generation.maxTokens',
      'text.generation.topP',
      'text.generation.frequencyPenalty',
      'text.generation.presencePenalty',
    ]);
    expect(TEXT_GENERATION_SETTINGS.map((d) => d.key)).toEqual(Object.keys(TEXT_GENERATION_DEFAULTS));
    for (const key of PENALTY_KEYS) expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
  });

  it('ships the NEUTRAL default 0, so no deployment changes a provider request until an admin writes a value', () => {
    for (const key of PENALTY_KEYS) {
      expect(TEXT_GENERATION_DEFAULTS[key], key).toBe(0);
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, key).toBe(0);
    }
  });

  it('rides the SAME channel as topP: global-kv, platform scope, pulled by text', () => {
    const topP = HOPE_SETTINGS_REGISTRY.getOrThrow('text.generation.topP');
    for (const key of PENALTY_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.tier, key).toBe('global-kv');
      expect(d.consumedBy, key).toEqual(['text']);
      expect(d.dataType, key).toBe('number');
      expect(d.maxScope, key).toBe('system');
      expect(d.globalOnly, key).toBe(true);
      expect(d.failMode, key).toBe('open-to-default');
      expect(d.sensitivity, key).toBe(topP.sensitivity);
      expect(d.editableBy, key).toBe(topP.editableBy);
      expect(d.category, key).toBe(topP.category);
      expect(d.label, key).toBeTruthy();
      expect(d.description, key).toBeTruthy();
    }
  });

  it.each(PENALTY_KEYS)('%s accepts exactly the range the Agent contract declares, both bounds inclusive', (key) => {
    const validate = HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate;
    const { minimum, maximum } = contractBound(contractNameOf(key));
    expect(validate, key).toBeTypeOf('function');
    expect(minimum).toBe(-2);
    expect(maximum).toBe(2);

    for (const ok of [minimum, -0.5, 0, 0.3, maximum]) expect(validate!(ok), `${key}=${ok}`).toBeFalsy();
    for (const bad of [minimum - 0.01, maximum + 0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validate!(bad), `${key}=${bad}`).toMatch(/between -2 and 2/);
    }
  });

  it('leaves the three pre-existing generation keys without an invariant (no behaviour change for them)', () => {
    for (const key of ['text.generation.temperature', 'text.generation.maxTokens', 'text.generation.topP']) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate, key).toBeUndefined();
    }
  });
});
