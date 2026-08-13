/**
 * STT config naming + v1 removal verification.
 *
 * Verifies that STT_PORT, LLM_PORT, and LLM_URL remain removed, and that
 * STT_URL is the canonical STT-related config key (dual-read of STT_V2_URL).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('STT config naming', () => {
  describe('IAppConfig interface', () => {
    const interfacePath = path.resolve(__dirname, '../../../../../../../../packages/domains/src/interfaces/IAppConfig.ts');

    const removedProperties = ['STT_PORT', 'LLM_PORT', 'LLM_URL'];

    for (const prop of removedProperties) {
      it(`should not contain ${prop} property`, () => {
        const content = readFile(interfacePath);
        expect(content).not.toMatch(new RegExp(`^\\s*${prop}\\s*:`, 'm'));
      });
    }

    // domains IAppConfig STT_V2_URL→STT_URL is outside this
    // package's exclusive ownership — asserted once Sweep/Wave 2 lands.

    // apps/fedl was removed; the gateway no longer carries the legacy
    // FEDL_PORT/FEDL_URL config keys. (TTS_PORT/TTS_URL were REINTRODUCED by
    // apps/tts — TTS is a real downstream service again, like
    // SMR/NLP/GUARDRAIL — so their presence is now correct, not v1 cruft.)
    it('should no longer contain FEDL_PORT, FEDL_URL properties', () => {
      const content = readFile(interfacePath);
      expect(content).not.toMatch(/^\s*FEDL_PORT\s*:/m);
      expect(content).not.toMatch(/^\s*FEDL_URL\s*:/m);
    });

    it('should still contain PORT and URL properties', () => {
      const content = readFile(interfacePath);
      expect(content).toMatch(/^\s*PORT\s*:/m);
      expect(content).toMatch(/^\s*URL\s*:/m);
    });
  });

  describe('ConfigService', () => {
    const configServicePath = path.resolve(__dirname, '..', 'config.service.ts');

    it('should not reference STT_PORT env variable', () => {
      const content = readFile(configServicePath);
      expect(content).not.toMatch(/STT_PORT/);
    });

    it('should reference STT_URL with dual-read of STT_V2_URL', () => {
      const content = readFile(configServicePath);
      expect(content).toMatch(/STT_URL:\s*process\.env\.STT_URL\s*\|\|\s*process\.env\.STT_V2_URL/);
    });

    it('should not reference LLM_PORT env variable', () => {
      const content = readFile(configServicePath);
      expect(content).not.toMatch(/LLM_PORT/);
    });

    it('should not reference LLM_URL env variable', () => {
      const content = readFile(configServicePath);
      expect(content).not.toMatch(/LLM_URL/);
    });

    // apps/fedl was removed; the config service no longer resolves the legacy
    // FEDL_* env keys. (TTS_URL/TTS_PORT are back for apps/tts —
    // a legitimate downstream service, resolved like SMR_URL/NLP_URL/GUARDRAIL_URL.)
    it('should no longer reference FEDL_URL, FEDL_PORT', () => {
      const content = readFile(configServicePath);
      expect(content).not.toMatch(/FEDL_URL/);
      expect(content).not.toMatch(/FEDL_PORT/);
    });
  });

  describe('Environment files should not contain removed variables', () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', '..');
    const envFiles = ['.env.test', 'apps/api/.env.sample', 'apps/api/.env.prod'];

    // STT_PORT is a valid gateway key (with STT_URL); do not
    // treat it as removed v1 cruft. Env files are Nest-owned.
    const removedVars = [
      { pattern: /^STT_WS_URL=/m, label: 'STT_WS_URL' },
      { pattern: /^LLM_PORT=/m, label: 'LLM_PORT' },
      { pattern: /^LLM_URL=/m, label: 'LLM_URL' },
    ];

    for (const envFile of envFiles) {
      const fullPath = path.join(projectRoot, envFile);
      if (!fs.existsSync(fullPath)) continue;

      for (const { pattern, label } of removedVars) {
        it(`${envFile} should not contain ${label}`, () => {
          const content = readFile(fullPath);
          expect(content).not.toMatch(pattern);
        });
      }
    }
  });
});
