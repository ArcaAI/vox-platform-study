import { describe, it, expect } from 'vitest';
import { SEED_GLOBAL_SETTING_IDS } from '../prisma/db_main/seed/00-constants';
import {
  GUARDRAIL_PROVIDER_MODELS,
  GUARDRAIL_PROVIDER_NAMES,
} from '../prisma/db_main/seed/11-global-setting';

interface GuardrailModelEntry {
  name: string;
  size: string;
}

interface GuardrailProviderCatalogEntry {
  provider: string;
  models: GuardrailModelEntry[];
}

// Guardrail provider/model catalog. The exact identifiers below are
// part of a cross-worker contract with the Guardrail Python service: provider
// order `['lm-studio', 'ollama', 'azure-openai']` and the lm-studio entry MUST
// expose `granite-guardian-4.1-8b`.
describe('Guardrail Provider-Model Catalog Seed Data (TASK-338)', () => {
  describe('GUARDRAIL_PROVIDER_MODELS constant', () => {
    it('should be a non-empty array', () => {
      expect(Array.isArray(GUARDRAIL_PROVIDER_MODELS)).toBe(true);
      expect(GUARDRAIL_PROVIDER_MODELS.length).toBeGreaterThan(0);
    });

    it('should contain entries for lm-studio, ollama, and azure-openai', () => {
      const providerNames = GUARDRAIL_PROVIDER_MODELS.map(
        (p: GuardrailProviderCatalogEntry) => p.provider,
      );
      expect(providerNames).toContain('lm-studio');
      expect(providerNames).toContain('ollama');
      expect(providerNames).toContain('azure-openai');
    });

    it('should have exactly 3 providers', () => {
      expect(GUARDRAIL_PROVIDER_MODELS.length).toBe(3);
    });

    it('each provider entry should have provider string and non-empty models array', () => {
      for (const entry of GUARDRAIL_PROVIDER_MODELS as GuardrailProviderCatalogEntry[]) {
        expect(typeof entry.provider).toBe('string');
        expect(entry.provider.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.models)).toBe(true);
        expect(entry.models.length).toBeGreaterThan(0);
      }
    });

    it('each model should have a non-empty name and a string size', () => {
      for (const entry of GUARDRAIL_PROVIDER_MODELS as GuardrailProviderCatalogEntry[]) {
        for (const model of entry.models) {
          expect(typeof model.name).toBe('string');
          expect(model.name.length).toBeGreaterThan(0);
          expect(typeof model.size).toBe('string');
        }
      }
    });
  });

  describe('GUARDRAIL_PROVIDER_NAMES constant', () => {
    it('should list the three canonical provider names in contract order', () => {
      expect(GUARDRAIL_PROVIDER_NAMES).toEqual([
        'lm-studio',
        'ollama',
        'azure-openai',
      ]);
    });
  });

  describe('lm-studio provider models (cross-worker contract)', () => {
    it('should include the default granite-guardian-4.1-8b model', () => {
      const lms = (GUARDRAIL_PROVIDER_MODELS as GuardrailProviderCatalogEntry[]).find(
        (p) => p.provider === 'lm-studio',
      );
      const names = lms!.models.map((m) => m.name);
      expect(names).toContain('granite-guardian-4.1-8b');
    });
  });

  describe('seed IDs for Guardrail provider-model catalog', () => {
    const SETTING_PREFIXES = ['GLOBAL', 'ARCAAI'] as const;

    for (const prefix of SETTING_PREFIXES) {
      const key = `${prefix}_UX_GUARDRAIL_PROVIDER_MODELS` as keyof typeof SEED_GLOBAL_SETTING_IDS;
      it(`should define ${key}`, () => {
        expect(SEED_GLOBAL_SETTING_IDS[key]).toBeDefined();
        expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(/^85000000-/);
      });
    }

    it('should have unique IDs for all Guardrail catalog entries', () => {
      const ids = ['GLOBAL', 'ARCAAI'].map(
        (prefix) =>
          SEED_GLOBAL_SETTING_IDS[
            `${prefix}_UX_GUARDRAIL_PROVIDER_MODELS` as keyof typeof SEED_GLOBAL_SETTING_IDS
          ],
      );
      const unique = new Set(ids);
      expect(unique.size).toBe(2);
    });
  });

  describe('seed IDs for the surviving SMR Azure deployment setting', () => {
    const SETTING_PREFIXES = ['GLOBAL', 'ARCAAI'] as const;

    for (const prefix of SETTING_PREFIXES) {
      const key = `${prefix}_SMR_AZURE_DEPLOYMENT` as keyof typeof SEED_GLOBAL_SETTING_IDS;
      it(`should define ${key}`, () => {
        expect(SEED_GLOBAL_SETTING_IDS[key]).toBeDefined();
        expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(/^85000000-/);
      });
    }

    // The guardrail engine settings (GUARDRAIL_PROVIDER /
    // GUARDRAIL_MODEL / GUARDRAIL_AZURE_DEPLOYMENT) were RETIRED: superseded
    // by the AiTaskDefault table (guardrail.validate) + the AiModel registry.
    for (const prefix of SETTING_PREFIXES) {
      for (const suffix of ['GUARDRAIL_PROVIDER', 'GUARDRAIL_MODEL', 'GUARDRAIL_AZURE_DEPLOYMENT']) {
        const key = `${prefix}_${suffix}`;
        it(`should NOT define retired id ${key} (TASK-506)`, () => {
          expect((SEED_GLOBAL_SETTING_IDS as Record<string, string>)[key]).toBeUndefined();
        });
      }
    }
  });
});
