import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPE_PRESETS, type ApiKeyScopePresetKey } from '../api-key-presets.js';

describe('API_KEY_SCOPE_PRESETS', () => {
  it('declares exactly the three presets, in order', () => {
    expect(API_KEY_SCOPE_PRESETS.map((p) => p.key)).toEqual(['consultation-app', 'types-codegen', 'agents-and-workflows']);
  });

  it('every preset carries a non-empty label, description, and scope list', () => {
    for (const preset of API_KEY_SCOPE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.scopes.length).toBeGreaterThan(0);
    }
  });

  it('no preset repeats a scope within itself', () => {
    for (const preset of API_KEY_SCOPE_PRESETS) {
      expect(new Set(preset.scopes).size).toBe(preset.scopes.length);
    }
  });

  it('"consultation-app" carries the day-1 clinic-app scope set', () => {
    const preset = API_KEY_SCOPE_PRESETS.find((p) => p.key === 'consultation-app');
    expect(preset?.scopes).toEqual([
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'consultation:report:write',
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'stt:model:read',
      'tts:speech:write',
      'tts:voice:read',
      'tenant:context-schema:read',
      'tenant:profile:read',
      'user:profile:read',
      'user:preferences:read',
      'user:preferences:write',
      'user:settings:read',
      'user:settings:write',
      'prompt:template:read',
      'dna-writing-style:ingest',
    ]);
  });

  it('"types-codegen" carries exactly the two catalogue-discovery scopes plus schema discovery', () => {
    const preset = API_KEY_SCOPE_PRESETS.find((p) => p.key === 'types-codegen');
    expect(preset?.scopes).toEqual(['tenant:context-schema:read', 'agent:definition:read', 'workflow:definition:read']);
  });

  it('"agents-and-workflows" carries the agent-invocation and workflow-run scopes', () => {
    const preset = API_KEY_SCOPE_PRESETS.find((p) => p.key === 'agents-and-workflows');
    expect(preset?.scopes).toEqual([
      'agent:definition:read',
      'agent:invocation:write',
      'workflow:definition:read',
      'workflow:run:read',
      'workflow:run:write',
      'workflows:execute',
    ]);
  });

  it('every preset key is assignable to ApiKeyScopePresetKey (compile-time contract exercised at runtime)', () => {
    for (const preset of API_KEY_SCOPE_PRESETS) {
      const key: ApiKeyScopePresetKey = preset.key;
      expect(typeof key).toBe('string');
    }
  });
});
