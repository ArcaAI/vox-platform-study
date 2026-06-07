import { describe, it, expect } from 'vitest';
import {
  SEED_GLOBAL_SETTING_IDS,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_TENANT_ID,
} from '../prisma/db_main/seed/00-constants';
import {
  SMR_PROVIDER_MODELS,
  SMR_PROVIDER_NAMES,
} from '../prisma/db_main/seed/11-global-setting';

interface SmrModelEntry {
  name: string;
  size: string;
}

interface SmrProviderCatalogEntry {
  provider: string;
  models: SmrModelEntry[];
}

describe('SMR Provider-Model Catalog Seed Data (TASK-240)', () => {
  describe('SMR_PROVIDER_MODELS constant', () => {
    it('should be a non-empty array', () => {
      expect(Array.isArray(SMR_PROVIDER_MODELS)).toBe(true);
      expect(SMR_PROVIDER_MODELS.length).toBeGreaterThan(0);
    });

    it('should contain entries for ollama, lm-studio, and azure-openai', () => {
      const providerNames = SMR_PROVIDER_MODELS.map(
        (p: SmrProviderCatalogEntry) => p.provider,
      );
      expect(providerNames).toContain('ollama');
      expect(providerNames).toContain('lm-studio');
      expect(providerNames).toContain('azure-openai');
    });

    it('should have exactly 3 providers', () => {
      expect(SMR_PROVIDER_MODELS.length).toBe(3);
    });

    it('each provider entry should have provider string and non-empty models array', () => {
      for (const entry of SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]) {
        expect(typeof entry.provider).toBe('string');
        expect(entry.provider.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.models)).toBe(true);
        expect(entry.models.length).toBeGreaterThan(0);
      }
    });

    it('each model should have a non-empty name and a string size', () => {
      for (const entry of SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]) {
        for (const model of entry.models) {
          expect(typeof model.name).toBe('string');
          expect(model.name.length).toBeGreaterThan(0);
          expect(typeof model.size).toBe('string');
        }
      }
    });
  });

  describe('SMR_PROVIDER_NAMES constant', () => {
    it('should list the three canonical provider names', () => {
      expect(SMR_PROVIDER_NAMES).toEqual([
        'lm-studio',
        'ollama',
        'azure-openai',
      ]);
    });
  });

  describe('ollama provider models', () => {
    it('should include granite4:latest', () => {
      const ollama = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'ollama',
      );
      const names = ollama!.models.map((m) => m.name);
      expect(names).toContain('granite4:latest');
    });

    it('should include gemma3:latest', () => {
      const ollama = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'ollama',
      );
      const names = ollama!.models.map((m) => m.name);
      expect(names).toContain('gemma3:latest');
    });

    it('should have 11 models', () => {
      const ollama = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'ollama',
      );
      expect(ollama!.models.length).toBe(11);
    });
  });

  describe('lm-studio provider models', () => {
    it('should include qwen3.5-4b', () => {
      const lms = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'lm-studio',
      );
      const names = lms!.models.map((m) => m.name);
      expect(names).toContain('qwen3.5-4b');
    });

    it('should include the default gemma-4 model', () => {
      const lms = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'lm-studio',
      );
      const names = lms!.models.map((m) => m.name);
      expect(names).toContain('google/gemma-4-e4b');
      expect(names).toContain('lmstudio-community/gemma-4-E4B-it-QAT-GGUF');
    });

    it('should have 16 models', () => {
      const lms = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'lm-studio',
      );
      expect(lms!.models.length).toBe(16);
    });
  });

  describe('azure-openai provider models', () => {
    it('should include gpt-4o-mini', () => {
      const azure = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'azure-openai',
      );
      const names = azure!.models.map((m) => m.name);
      expect(names).toContain('gpt-4o-mini');
    });

    it('should have 1 model', () => {
      const azure = (SMR_PROVIDER_MODELS as SmrProviderCatalogEntry[]).find(
        (p) => p.provider === 'azure-openai',
      );
      expect(azure!.models.length).toBe(1);
    });
  });

  describe('seed IDs for SMR provider-model catalog', () => {
    const SETTING_PREFIXES = ['GLOBAL', 'ARCAAI', 'FOURBITS', 'MUMBAI'] as const;

    for (const prefix of SETTING_PREFIXES) {
      const key = `${prefix}_UX_SMR_PROVIDER_MODELS` as keyof typeof SEED_GLOBAL_SETTING_IDS;
      it(`should define ${key}`, () => {
        expect(SEED_GLOBAL_SETTING_IDS[key]).toBeDefined();
        expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(/^85000000-/);
      });
    }

    it('should have unique IDs for all SMR catalog entries', () => {
      const ids = ['GLOBAL', 'ARCAAI', 'FOURBITS', 'MUMBAI'].map(
        (prefix) =>
          SEED_GLOBAL_SETTING_IDS[
            `${prefix}_UX_SMR_PROVIDER_MODELS` as keyof typeof SEED_GLOBAL_SETTING_IDS
          ],
      );
      const unique = new Set(ids);
      expect(unique.size).toBe(4);
    });
  });
});
