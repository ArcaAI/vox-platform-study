/**
 * STT v1 Config Removal Verification Tests (TASK-210 Phase 1)
 *
 * Verifies that STT_PORT, STT_URL, LLM_PORT, and LLM_URL have been
 * removed from the configuration service and IAppConfig interface.
 * Only STT_V2_URL should remain for STT-related config.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
}

function countPatternInLines(content: string, pattern: RegExp, exclude?: RegExp): number {
    return content.split('\n').filter(
        (line) => pattern.test(line) && (!exclude || !exclude.test(line)),
    ).length;
}

describe('STT v1 Config Removal (TASK-210 Phase 1)', () => {
    describe('IAppConfig interface', () => {
        const interfacePath = path.resolve(
            __dirname,
            '../../../../../../../../packages/domains/src/interfaces/IAppConfig.ts',
        );

        const removedProperties = ['STT_PORT', 'STT_URL', 'LLM_PORT', 'LLM_URL'];

        for (const prop of removedProperties) {
            it(`should not contain ${prop} property`, () => {
                const content = readFile(interfacePath);
                expect(content).not.toMatch(new RegExp(`^\\s*${prop}\\s*:`, 'm'));
            });
        }

        it('should still contain STT_V2_URL property', () => {
            const content = readFile(interfacePath);
            expect(content).toMatch(/^\s*STT_V2_URL\s*:/m);
        });

        // apps/tts and apps/fedl were removed; the gateway no longer carries
        // the legacy TTS_PORT/TTS_URL/FEDL_PORT/FEDL_URL config keys.
        it('should no longer contain TTS_PORT, TTS_URL, FEDL_PORT, FEDL_URL properties', () => {
            const content = readFile(interfacePath);
            expect(content).not.toMatch(/^\s*TTS_PORT\s*:/m);
            expect(content).not.toMatch(/^\s*TTS_URL\s*:/m);
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

        it('should not reference STT_URL env variable (distinct from STT_V2_URL)', () => {
            const content = readFile(configServicePath);
            const count = countPatternInLines(content, /STT_URL/, /STT_V2_URL/);
            expect(count).toBe(0);
        });

        it('should not reference LLM_PORT env variable', () => {
            const content = readFile(configServicePath);
            expect(content).not.toMatch(/LLM_PORT/);
        });

        it('should not reference LLM_URL env variable', () => {
            const content = readFile(configServicePath);
            expect(content).not.toMatch(/LLM_URL/);
        });

        it('should still reference STT_V2_URL', () => {
            const content = readFile(configServicePath);
            expect(content).toMatch(/STT_V2_URL/);
        });

        // apps/tts and apps/fedl were removed; the config service no longer
        // resolves the legacy TTS_*/FEDL_* env keys.
        it('should no longer reference TTS_URL, TTS_PORT, FEDL_URL, FEDL_PORT', () => {
            const content = readFile(configServicePath);
            expect(content).not.toMatch(/TTS_URL/);
            expect(content).not.toMatch(/TTS_PORT/);
            expect(content).not.toMatch(/FEDL_URL/);
            expect(content).not.toMatch(/FEDL_PORT/);
        });
    });

    describe('Environment files should not contain removed variables', () => {
        const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', '..');
        const envFiles = [
            '.env.production',
            '.env.test',
            'apps/api/.env.example',
            'apps/api/.env.production',
        ];

        const removedVars = [
            { pattern: /^STT_PORT=/m, label: 'STT_PORT' },
            { pattern: /^STT_URL=/m, label: 'STT_URL' },
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
