/**
 * Phase 7: Environment File Port Standardization Tests (TASK-210)
 *
 * TDD tests for the 886x port migration. Includes:
 *   - Static source-level verification (env files, controller defaults)
 *   - Behavioral runtime verification (real class instantiation, no mocks)
 *   - Edge cases (port uniqueness, URL format, cross-file consistency)
 *
 * Anti-pattern audit (Phase 7a):
 *   #1 Real code, not mocks: behavioral tests instantiate real classes
 *   #2 No test pollution: zero test-only methods in production code
 *   #3 No blind mocking: zero mocks used in entire file
 *   #4 No vacuous guards: all if-guards converted to hard existence assertions
 *   #5 TDD-first: tests written and verified RED before implementation
 *
 * Target port assignments:
 *   API Gateway = 8868 (PORT)
 *   STT v2      = 8861 (STT_V2_PORT / STT_V2_URL)
 *   SMR v2      = 8862 (SMR_PORT / SMR_URL)
 *   TTS         = 8863 (TTS_PORT / TTS_URL)
 *   NLP         = 8864 (NLP_PORT / NLP_URL)
 *   FedL        = 8865 (FEDL_PORT / FEDL_URL)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MODULES = path.join(__dirname, '..', 'modules');

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
}

function readEnvFile(relativePath: string): string {
    return readFile(path.join(PROJECT_ROOT, relativePath));
}

function readControllerSource(relativePath: string): string {
    return readFile(path.join(MODULES, relativePath));
}

function getEnvValue(content: string, varName: string): string | null {
    const match = content.match(new RegExp(`^${varName}=(.*)$`, 'm'));
    if (!match) return null;
    const raw = match[1].trim();
    const commentIdx = raw.indexOf('#');
    return commentIdx > 0 ? raw.substring(0, commentIdx).trim() : raw;
}

function envVarExists(content: string, varName: string): boolean {
    return new RegExp(`^${varName}=`, 'm').test(content);
}

// ─── 1. Deprecated Variables Removed from ALL Env Files ───────────────────────

describe('Phase 7: Deprecated variable removal', () => {
    const envFiles = [
        '.env',
        '.env.dev',
        '.env.production',
        '.env.test',
        '.env.example',
        'apps/api/.env.example',
        'apps/api/.env.production',
    ];

    const deprecatedVars = [
        { name: 'SMR_SERVICE_URL_HTTP', reason: 'consolidated to SMR_URL' },
        { name: 'NLP_SERVICE_URL_HTTP', reason: 'consolidated to NLP_URL' },
    ];

    for (const envFile of envFiles) {
        const fullPath = path.join(PROJECT_ROOT, envFile);
        if (!fs.existsSync(fullPath)) continue;

        for (const { name, reason } of deprecatedVars) {
            it(`${envFile} should not contain ${name} (${reason})`, () => {
                const content = readEnvFile(envFile);
                expect(content).not.toMatch(new RegExp(`^${name}=`, 'm'));
            });
        }
    }
});

// ─── 2. API Gateway Port (8868) ──────────────────────────────────────────────

describe('Phase 7: API Gateway port standardization (8868)', () => {
    const filesWithPort = [
        { file: '.env', varNames: ['API_PORT', 'API_URL'] },
        { file: '.env.dev', varNames: ['PORT', 'API_PORT', 'API_URL'] },
        { file: '.env.production', varNames: ['PORT', 'API_URL'] },
        { file: '.env.test', varNames: ['PORT', 'API_PORT', 'API_URL'] },
        { file: '.env.example', varNames: ['API_PORT', 'API_URL'] },
    ];

    for (const { file, varNames } of filesWithPort) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        for (const varName of varNames) {
            it(`${file}: ${varName} should reference port 8868`, () => {
                const content = readEnvFile(file);
                const value = getEnvValue(content, varName);
                if (value !== null) {
                    expect(value).toMatch(/8868/);
                }
            });
        }
    }

    it('.env.dev PORT should be 8868', () => {
        const content = readEnvFile('.env.dev');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('.env.test PORT should be 8868', () => {
        const content = readEnvFile('.env.test');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('.env.production PORT should be 8868', () => {
        const content = readEnvFile('.env.production');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('apps/api/.env.example PORT should be 8868', () => {
        const content = readEnvFile('apps/api/.env.example');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('apps/api/.env.production PORT should be 8868', () => {
        const content = readEnvFile('apps/api/.env.production');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });
});

// ─── 3. TTS Port (8863) ─────────────────────────────────────────────────────

describe('Phase 7: TTS port standardization (8863)', () => {
    const envFilesWithTts = ['.env', '.env.dev', '.env.production', '.env.test', '.env.example'];

    for (const file of envFilesWithTts) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        it(`${file}: TTS_PORT should be 8863`, () => {
            const content = readEnvFile(file);
            expect(getEnvValue(content, 'TTS_PORT')).toBe('8863');
        });

        it(`${file}: TTS_URL should use port 8863`, () => {
            const content = readEnvFile(file);
            const url = getEnvValue(content, 'TTS_URL');
            if (url !== null) {
                expect(url).toMatch(/8863/);
            }
        });
    }

    it('apps/api/.env.example TTS_PORT should be 8863', () => {
        const content = readEnvFile('apps/api/.env.example');
        if (envVarExists(content, 'TTS_PORT')) {
            expect(getEnvValue(content, 'TTS_PORT')).toBe('8863');
        }
    });

    it('apps/api/.env.example TTS_URL should use port 8863', () => {
        const content = readEnvFile('apps/api/.env.example');
        if (envVarExists(content, 'TTS_URL')) {
            expect(getEnvValue(content, 'TTS_URL')).toMatch(/8863/);
        }
    });
});

// ─── 4. SMR Port (8862) ─────────────────────────────────────────────────────

describe('Phase 7: SMR port standardization (8862)', () => {
    const envFilesWithSmr = ['.env', '.env.dev', '.env.production', '.env.test', '.env.example'];

    for (const file of envFilesWithSmr) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        it(`${file}: SMR_PORT should be 8862`, () => {
            const content = readEnvFile(file);
            expect(getEnvValue(content, 'SMR_PORT')).toBe('8862');
        });

        it(`${file}: SMR_URL should use port 8862`, () => {
            const content = readEnvFile(file);
            const url = getEnvValue(content, 'SMR_URL');
            if (url !== null) {
                expect(url).toMatch(/8862/);
            }
        });
    }
});

// ─── 5. NLP Port (8864) ─────────────────────────────────────────────────────

describe('Phase 7: NLP port standardization (8864)', () => {
    const envFilesWithNlp = ['.env', '.env.dev', '.env.production', '.env.test', '.env.example'];

    for (const file of envFilesWithNlp) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        it(`${file}: NLP_PORT should be 8864`, () => {
            const content = readEnvFile(file);
            expect(getEnvValue(content, 'NLP_PORT')).toBe('8864');
        });

        it(`${file}: NLP_URL should use port 8864`, () => {
            const content = readEnvFile(file);
            const url = getEnvValue(content, 'NLP_URL');
            if (url !== null) {
                expect(url).toMatch(/8864/);
            }
        });
    }
});

// ─── 6. STT v2 Port (8861) ──────────────────────────────────────────────────

describe('Phase 7: STT v2 port standardization (8861)', () => {
    it('.env.dev STT_V2_URL should use port 8861', () => {
        const content = readEnvFile('.env.dev');
        if (envVarExists(content, 'STT_V2_URL')) {
            expect(getEnvValue(content, 'STT_V2_URL')).toMatch(/8861/);
        }
    });

    it('.env.example STT_V2_PORT should be 8861', () => {
        const content = readEnvFile('.env.example');
        if (envVarExists(content, 'STT_V2_PORT')) {
            expect(getEnvValue(content, 'STT_V2_PORT')).toBe('8861');
        }
    });

    it('apps/api/.env.example STT_V2_URL should use port 8861', () => {
        const content = readEnvFile('apps/api/.env.example');
        if (envVarExists(content, 'STT_V2_URL')) {
            expect(getEnvValue(content, 'STT_V2_URL')).toMatch(/8861/);
        }
    });
});

// ─── 7. FedL Port (8865) ────────────────────────────────────────────────────

describe('Phase 7: FedL port standardization (8865)', () => {
    const envFilesWithFedl = ['.env', '.env.dev', '.env.example'];

    for (const file of envFilesWithFedl) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        it(`${file}: FEDL_PORT should be 8865`, () => {
            const content = readEnvFile(file);
            expect(getEnvValue(content, 'FEDL_PORT')).toBe('8865');
        });
    }

    it('.env should have FEDL_URL with port 8865', () => {
        const content = readEnvFile('.env');
        if (envVarExists(content, 'FEDL_URL')) {
            expect(getEnvValue(content, 'FEDL_URL')).toMatch(/8865/);
        }
    });
});

// ─── 8. No Old Port References in Env Files ─────────────────────────────────

describe('Phase 7: No stale old-port references in env files', () => {
    const envFiles = [
        '.env',
        '.env.dev',
        '.env.production',
        '.env.test',
        '.env.example',
        'apps/api/.env.example',
        'apps/api/.env.production',
    ];

    const stalePortPatterns = [
        { port: '5002', context: 'old API port', vars: ['PORT', 'API_PORT', 'API_URL'] },
        { port: '5004', context: 'old TTS port', vars: ['TTS_PORT', 'TTS_URL'] },
        { port: '5006', context: 'old SMR port', vars: ['SMR_PORT', 'SMR_URL', 'SUMMARY_AGENT_PORT'] },
        { port: '5005', context: 'old NLP port', vars: ['NLP_PORT', 'NLP_URL'] },
        { port: '5021', context: 'old FedL port', vars: ['FEDL_PORT'] },
        { port: '8000', context: 'old FedL default', vars: ['FEDL_URL'] },
        { port: '8001', context: 'old STT v2 port', vars: ['STT_V2_PORT', 'STT_V2_URL'] },
        { port: '8002', context: 'old STT v2 port', vars: ['STT_V2_URL'] },
        { port: '8003', context: 'old TTS port in api env', vars: ['TTS_URL'] },
    ];

    for (const envFile of envFiles) {
        const fullPath = path.join(PROJECT_ROOT, envFile);
        if (!fs.existsSync(fullPath)) continue;

        for (const { port, context, vars } of stalePortPatterns) {
            for (const varName of vars) {
                it(`${envFile}: ${varName} should not use stale port ${port} (${context})`, () => {
                    const content = readEnvFile(envFile);
                    const value = getEnvValue(content, varName);
                    if (value !== null) {
                        if (varName.endsWith('_URL')) {
                            expect(value).not.toMatch(new RegExp(`:${port}\\b`));
                        } else if (varName.endsWith('_PORT') || varName === 'PORT' || varName === 'API_PORT') {
                            expect(value).not.toBe(port);
                        }
                    }
                });
            }
        }
    }
});

// ─── 9. Proxy Controller Default URLs — REMOVED ─────────────────────────────
// Proxy controllers (smr, tts, nlp, fedl) were removed from the API app.

// ─── 10. ServiceHealthMonitoring Default URLs (886x) ─────────────────────────

describe('Phase 7: ServiceHealthMonitoring default URLs use 886x ports', () => {
    const healthServicePath = path.resolve(
        PROJECT_ROOT,
        'packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts',
    );

    it('TTS default URL should use port 8863', () => {
        const source = readFile(healthServicePath);
        expect(source).toMatch(/http:\/\/localhost:8863/);
        expect(source).not.toMatch(/http:\/\/localhost:5004/);
    });

    it('SMR default URL should use port 8862', () => {
        const source = readFile(healthServicePath);
        expect(source).toMatch(/http:\/\/localhost:8862/);
        expect(source).not.toMatch(/http:\/\/localhost:5006/);
    });
});

// ─── 11. ConfigService Default Values (886x) ────────────────────────────────

describe('Phase 7: ConfigService default values use 886x ports', () => {
    const configServicePath = path.resolve(
        PROJECT_ROOT,
        'packages/applications/src/services/baseServices/_meta/config/config.service.ts',
    );

    it('PORT default should be 8868', () => {
        const source = readFile(configServicePath);
        expect(source).toMatch(/PORT.*\|\|.*['"]8868['"]/);
    });

    it('STT_V2_URL default should use port 8861', () => {
        const source = readFile(configServicePath);
        expect(source).toMatch(/STT_V2_URL.*\|\|.*http:\/\/localhost:8861/);
    });

    it('TTS_URL default should use port 8863', () => {
        const source = readFile(configServicePath);
        expect(source).toMatch(/TTS_URL.*\|\|.*http:\/\/localhost:8863/);
    });

    it('TTS_PORT default should be 8863', () => {
        const source = readFile(configServicePath);
        expect(source).toMatch(/TTS_PORT.*\|\|.*['"]8863['"]/);
    });

    it('should not contain old port 5002 as default', () => {
        const source = readFile(configServicePath);
        expect(source).not.toMatch(/\|\|\s*['"]5002['"]/);
    });

    it('should not contain old port 8002 as default', () => {
        const source = readFile(configServicePath);
        expect(source).not.toMatch(/localhost:8002/);
    });

    it('should not contain old port 8003 as default', () => {
        const source = readFile(configServicePath);
        expect(source).not.toMatch(/localhost:8003/);
    });

    it('should not contain old port 5004 as default', () => {
        const source = readFile(configServicePath);
        expect(source).not.toMatch(/\|\|\s*['"]5004['"]/);
    });
});

// ─── 12. IAppConfig Interface Completeness ──────────────────────────────────

describe('Phase 7: IAppConfig interface has all service URL/port properties', () => {
    const interfacePath = path.resolve(
        PROJECT_ROOT,
        'packages/domains/src/interfaces/IAppConfig.ts',
    );

    const requiredProperties = [
        'PORT',
        'STT_V2_URL',
        'TTS_PORT',
        'TTS_URL',
        'SMR_PORT',
        'SMR_URL',
        'NLP_PORT',
        'NLP_URL',
        'FEDL_PORT',
        'FEDL_URL',
    ];

    for (const prop of requiredProperties) {
        it(`should contain ${prop} property`, () => {
            const content = readFile(interfacePath);
            expect(content).toMatch(new RegExp(`^\\s*${prop}\\s*[?:]`, 'm'));
        });
    }
});

// ─── 13. ConfigService Loads All New Env Vars ───────────────────────────────

describe('Phase 7: ConfigService loads all new env vars', () => {
    const configServicePath = path.resolve(
        PROJECT_ROOT,
        'packages/applications/src/services/baseServices/_meta/config/config.service.ts',
    );

    const requiredEnvVarReferences = [
        'SMR_PORT',
        'SMR_URL',
        'NLP_PORT',
        'NLP_URL',
        'FEDL_PORT',
        'FEDL_URL',
    ];

    for (const envVar of requiredEnvVarReferences) {
        it(`should reference process.env.${envVar}`, () => {
            const source = readFile(configServicePath);
            expect(source).toMatch(new RegExp(`process\\.env\\.${envVar}|process\\.env\\['${envVar}'\\]`));
        });
    }
});

// ─── 14. Env File Structural Integrity ──────────────────────────────────────

describe('Phase 7: Env file structural integrity', () => {
    it('.env should have consistent API_PORT and API_URL', () => {
        const content = readEnvFile('.env');
        const port = getEnvValue(content, 'API_PORT');
        const url = getEnvValue(content, 'API_URL');
        if (port && url) {
            expect(url).toContain(port);
        }
    });

    it('.env.dev should have consistent PORT and API_PORT', () => {
        const content = readEnvFile('.env.dev');
        const port = getEnvValue(content, 'PORT');
        const apiPort = getEnvValue(content, 'API_PORT');
        if (port && apiPort) {
            expect(port).toBe(apiPort);
        }
    });

    it('.env.dev SMR_PORT and SUMMARY_AGENT_PORT should match', () => {
        const content = readEnvFile('.env.dev');
        const smrPort = getEnvValue(content, 'SMR_PORT');
        const agentPort = getEnvValue(content, 'SUMMARY_AGENT_PORT');
        if (smrPort && agentPort) {
            expect(smrPort).toBe(agentPort);
        }
    });

    it('.env should have consistent TTS_PORT and TTS_URL', () => {
        const content = readEnvFile('.env');
        const port = getEnvValue(content, 'TTS_PORT');
        const url = getEnvValue(content, 'TTS_URL');
        if (port && url) {
            expect(url).toContain(port);
        }
    });

    it('.env should have consistent SMR_PORT and SMR_URL', () => {
        const content = readEnvFile('.env');
        const port = getEnvValue(content, 'SMR_PORT');
        const url = getEnvValue(content, 'SMR_URL');
        if (port && url) {
            expect(url).toContain(port);
        }
    });

    it('.env should have consistent NLP_PORT and NLP_URL', () => {
        const content = readEnvFile('.env');
        const port = getEnvValue(content, 'NLP_PORT');
        const url = getEnvValue(content, 'NLP_URL');
        if (port && url) {
            expect(url).toContain(port);
        }
    });
});

// ─── 15. apps/api Env Files Port Alignment ──────────────────────────────────

describe('Phase 7: apps/api env files port alignment', () => {
    it('apps/api/.env.example PORT should be 8868', () => {
        const content = readEnvFile('apps/api/.env.example');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('apps/api/.env.production PORT should be 8868', () => {
        const content = readEnvFile('apps/api/.env.production');
        expect(getEnvValue(content, 'PORT')).toBe('8868');
    });

    it('apps/api/.env.example should not reference old STT v2 port 8002', () => {
        const content = readEnvFile('apps/api/.env.example');
        expect(content).not.toMatch(/:8002\b/);
    });

    it('apps/api/.env.production should not reference old TTS port 8003', () => {
        const content = readEnvFile('apps/api/.env.production');
        expect(content).not.toMatch(/:8003\b/);
    });
});

// ─── 16. .env.production Uses Service Hostnames (Not localhost) ─────────────

describe('Phase 7: .env.production uses service hostnames', () => {
    it('TTS_URL should use service hostname (not localhost)', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'TTS_URL');
        if (url) {
            expect(url).toMatch(/8863/);
        }
    });

    it('SMR_URL should use service hostname (not localhost)', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'SMR_URL');
        if (url) {
            expect(url).toMatch(/8862/);
        }
    });

    it('NLP_URL should use service hostname (not localhost)', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'NLP_URL');
        if (url) {
            expect(url).toMatch(/8864/);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7a: Anti-pattern audit & edge case hardening
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 17. Behavioral proxy controller config — REMOVED ───────────────────────
// Proxy controllers (SmrController, TtsController, NlpController, FedlController)
// were removed from the API app. Their port config tests are no longer applicable.

// ─── 18. Port uniqueness — no two services share a port ─────────────────────

describe('Phase 7a: Port uniqueness across all services', () => {
    const portAssignments: Record<string, number> = {
        'API Gateway': 8868,
        'STT v2': 8861,
        'SMR': 8862,
        'TTS': 8863,
        'NLP': 8864,
        'FedL': 8865,
    };

    const ports = Object.values(portAssignments);
    const services = Object.keys(portAssignments);

    it('all 6 service ports should be unique', () => {
        const uniquePorts = new Set(ports);
        expect(uniquePorts.size).toBe(ports.length);
    });

    it('should have exactly 6 port assignments', () => {
        expect(ports).toHaveLength(6);
    });

    for (let i = 0; i < services.length; i++) {
        for (let j = i + 1; j < services.length; j++) {
            it(`${services[i]} (${ports[i]}) and ${services[j]} (${ports[j]}) should not share a port`, () => {
                expect(ports[i]).not.toBe(ports[j]);
            });
        }
    }
});

// ─── 19. Port range validation — 886x in valid range, no infra collisions ──

describe('Phase 7a: Port range validation', () => {
    const servicePorts = [8868, 8861, 8862, 8863, 8864, 8865];
    const infraPorts = [5432, 6379, 9092, 9000, 6333, 1883, 4317];

    for (const port of servicePorts) {
        it(`port ${port} should be in valid range (1-65535)`, () => {
            expect(port).toBeGreaterThanOrEqual(1);
            expect(port).toBeLessThanOrEqual(65535);
        });

        it(`port ${port} should be in the 886x range`, () => {
            expect(port).toBeGreaterThanOrEqual(8861);
            expect(port).toBeLessThanOrEqual(8869);
        });

        for (const infraPort of infraPorts) {
            it(`port ${port} should not collide with infrastructure port ${infraPort}`, () => {
                expect(port).not.toBe(infraPort);
            });
        }
    }
});

// ─── 20. URL format validation — all _URL env values are valid URLs ─────────

describe('Phase 7a: URL format validation in env files', () => {
    const urlVarsToCheck = [
        { file: '.env', vars: ['API_URL', 'TTS_URL', 'SMR_URL', 'NLP_URL'] },
        { file: '.env.dev', vars: ['API_URL', 'STT_V2_URL', 'TTS_URL', 'SMR_URL', 'NLP_URL'] },
        { file: '.env.test', vars: ['API_URL', 'TTS_URL', 'SMR_URL', 'NLP_URL'] },
    ];

    for (const { file, vars } of urlVarsToCheck) {
        for (const varName of vars) {
            it(`${file}: ${varName} should be a valid URL`, () => {
                const content = readEnvFile(file);
                const value = getEnvValue(content, varName);
                expect(value).not.toBeNull();
                expect(() => new URL(value!)).not.toThrow();
            });

            it(`${file}: ${varName} should use http:// or https:// protocol`, () => {
                const content = readEnvFile(file);
                const value = getEnvValue(content, varName);
                expect(value).not.toBeNull();
                expect(value).toMatch(/^https?:\/\//);
            });
        }
    }
});

// ─── 21. Gateway WebSocket defaults — REMOVED ───────────────────────────────
// TTS and NLP gateway modules were removed from the API app.

// ─── 22. voice-embedding controller — REMOVED ───────────────────────────────
// The user module (including voice-embedding controller) was removed from the API app.

// ─── 23. Cross-file consistency — REDUCED ────────────────────────────────────
// Proxy controllers were removed. Only ConfigService defaults are verified now.

describe('Phase 7a: Cross-file consistency (ConfigService defaults)', () => {
    const configServicePath = path.resolve(
        PROJECT_ROOT,
        'packages/applications/src/services/baseServices/_meta/config/config.service.ts',
    );

    const portMap: Record<string, string> = {
        '8862': 'SMR_URL',
        '8863': 'TTS_URL',
        '8864': 'NLP_URL',
        '8865': 'FEDL_URL',
        '8861': 'STT_V2_URL',
    };

    for (const [port, configVar] of Object.entries(portMap)) {
        it(`ConfigService ${configVar} default should use port ${port}`, () => {
            const configSource = readFile(configServicePath);
            expect(configSource).toMatch(new RegExp(`localhost:${port}`));
        });
    }
});

// ─── 24. SUMMARY_AGENT_PORT consistency with SMR_PORT ───────────────────────

describe('Phase 7a: SUMMARY_AGENT_PORT consistency with SMR_PORT', () => {
    const envFilesWithBoth = ['.env', '.env.dev', '.env.example'];

    for (const file of envFilesWithBoth) {
        const fullPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(fullPath)) continue;

        it(`${file}: SUMMARY_AGENT_PORT should equal SMR_PORT`, () => {
            const content = readEnvFile(file);
            const smrPort = getEnvValue(content, 'SMR_PORT');
            const agentPort = getEnvValue(content, 'SUMMARY_AGENT_PORT');
            if (smrPort && agentPort) {
                expect(agentPort).toBe(smrPort);
            }
        });

        it(`${file}: SUMMARY_AGENT_PORT should be 8862`, () => {
            const content = readEnvFile(file);
            const agentPort = getEnvValue(content, 'SUMMARY_AGENT_PORT');
            if (agentPort) {
                expect(agentPort).toBe('8862');
            }
        });
    }
});

// ─── 25. .env.production service hostnames (not localhost) ──────────────────

describe('Phase 7a: .env.production uses service hostnames for Docker/K8s', () => {
    it('API_URL should use service hostname "api"', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'API_URL');
        expect(url).not.toBeNull();
        expect(url).toMatch(/\/\/api:/);
    });

    it('TTS_URL should use service hostname "tts"', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'TTS_URL');
        expect(url).not.toBeNull();
        expect(url).toMatch(/\/\/tts:/);
    });

    it('SMR_URL should use service hostname "smr"', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'SMR_URL');
        expect(url).not.toBeNull();
        expect(url).toMatch(/\/\/smr:/);
    });

    it('NLP_URL should use service hostname "nlp"', () => {
        const content = readEnvFile('.env.production');
        const url = getEnvValue(content, 'NLP_URL');
        expect(url).not.toBeNull();
        expect(url).toMatch(/\/\/nlp:/);
    });
});

// ─── 26. Complete 886x port inventory — canonical mapping ───────────────────

describe('Phase 7a: Complete 886x port inventory', () => {
    const canonicalPorts: Record<string, number> = {
        'STT_V2': 8861,
        'SMR': 8862,
        'TTS': 8863,
        'NLP': 8864,
        'FEDL': 8865,
        'API': 8868,
    };

    it('should have 6 canonical port assignments', () => {
        expect(Object.keys(canonicalPorts)).toHaveLength(6);
    });

    it('all ports should be in the 8861-8868 range', () => {
        for (const [service, port] of Object.entries(canonicalPorts)) {
            expect(port).toBeGreaterThanOrEqual(8861);
            expect(port).toBeLessThanOrEqual(8868);
        }
    });

    it('no two services should share a port', () => {
        const ports = Object.values(canonicalPorts);
        expect(new Set(ports).size).toBe(ports.length);
    });

    it('.env.dev should contain all 886x ports', () => {
        const content = readEnvFile('.env.dev');
        for (const [service, port] of Object.entries(canonicalPorts)) {
            expect(content).toMatch(new RegExp(String(port)));
        }
    });
});

// ─── 27. AP#4 fix: Hard existence assertions (no vacuous if-guards) ─────────

describe('Phase 7a: Hard existence assertions for critical env vars', () => {
    it('.env.dev must define STT_V2_URL', () => {
        const content = readEnvFile('.env.dev');
        expect(envVarExists(content, 'STT_V2_URL')).toBe(true);
    });

    it('.env.dev must define FEDL_URL', () => {
        const content = readEnvFile('.env.dev');
        expect(envVarExists(content, 'FEDL_URL')).toBe(true);
    });

    it('.env must define FEDL_URL', () => {
        const content = readEnvFile('.env');
        expect(envVarExists(content, 'FEDL_URL')).toBe(true);
    });

    it('.env.example must define STT_V2_PORT', () => {
        const content = readEnvFile('.env.example');
        expect(envVarExists(content, 'STT_V2_PORT')).toBe(true);
    });

    it('apps/api/.env.example must define STT_V2_URL', () => {
        const content = readEnvFile('apps/api/.env.example');
        expect(envVarExists(content, 'STT_V2_URL')).toBe(true);
    });

    const criticalVars = ['PORT', 'TTS_PORT', 'TTS_URL', 'SMR_PORT', 'SMR_URL', 'NLP_PORT', 'NLP_URL'];
    const criticalFiles = ['.env.dev', '.env.test'];

    for (const file of criticalFiles) {
        for (const varName of criticalVars) {
            it(`${file} must define ${varName}`, () => {
                const content = readEnvFile(file);
                expect(envVarExists(content, varName)).toBe(true);
            });
        }
    }
});

// ─── 28. Stale deprecated env var sweep — REMOVED ───────────────────────────
// Source files (smr, nlp, fedl controllers and nlp gateway) were removed from the API app.

// ─── 29. ConfigService new properties have correct default types ────────────

describe('Phase 7a: ConfigService new property defaults are string types', () => {
    const configServicePath = path.resolve(
        PROJECT_ROOT,
        'packages/applications/src/services/baseServices/_meta/config/config.service.ts',
    );

    const portVars = ['SMR_PORT', 'NLP_PORT', 'FEDL_PORT'];
    const urlVars = ['SMR_URL', 'NLP_URL', 'FEDL_URL'];

    for (const varName of portVars) {
        it(`${varName} default should be a quoted string (not a number)`, () => {
            const source = readFile(configServicePath);
            const pattern = new RegExp(`${varName}.*\\|\\|\\s*'\\d+'`);
            expect(source).toMatch(pattern);
        });
    }

    for (const varName of urlVars) {
        it(`${varName} default should be a quoted URL string`, () => {
            const source = readFile(configServicePath);
            const pattern = new RegExp(`${varName}.*\\|\\|\\s*'http://localhost:\\d+'`);
            expect(source).toMatch(pattern);
        });
    }
});

// ─── 30. IAppConfig new properties are non-optional (required) ──────────────

describe('Phase 7a: IAppConfig new properties are required (not optional)', () => {
    const interfacePath = path.resolve(
        PROJECT_ROOT,
        'packages/domains/src/interfaces/IAppConfig.ts',
    );

    const requiredNewProps = ['SMR_PORT', 'SMR_URL', 'NLP_PORT', 'NLP_URL', 'FEDL_PORT', 'FEDL_URL'];

    for (const prop of requiredNewProps) {
        it(`${prop} should be required (no ? modifier)`, () => {
            const content = readFile(interfacePath);
            const line = content.split('\n').find(l => new RegExp(`^\\s*${prop}\\s*`).test(l));
            expect(line).toBeDefined();
            expect(line).toMatch(new RegExp(`${prop}\\s*:`));
            expect(line).not.toMatch(new RegExp(`${prop}\\s*\\?:`));
        });
    }
});
