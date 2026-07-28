/**
 * Environment-file port topology.
 *
 * ── WHY THIS FILE WAS REWRITTEN (TASK-558 lane D, D6) ────────────────────────
 * The previous version asserted that EVERY env file used the DEV ports
 * (8868/8861/8862/8863/8864/8865/8866). Two things have since made that false,
 * and it was failing 26 tests at HEAD:
 *
 *  1. Commit d84f538e (TASK-557) gave the TEST environment its OWN application
 *     ports — DEV + 100 — so a dev stack and a test stack can run at the same
 *     time. `.env.test` therefore uses 8968/8961/8962/8963/8964/8965/8966 and
 *     asserting 8868 against it is simply wrong. Reality wins: the scheme is the
 *     contract, and this file now encodes the scheme.
 *  2. TASK-558 lane A untracked `.env.dev` (it was committed WITH credentials —
 *     see the plan §2.4 `.gitignore` typo). A clean clone and every CI job now
 *     have no `.env.dev` at all, so 12 of the old assertions crashed with ENOENT
 *     rather than failing an assertion. Local dev files are read only when
 *     present.
 *  3. Lane B retired the root `.env` (compose now gets a generated
 *     `infrastructure/docker/.env`), and lane D regenerated the example files —
 *     the root `.env.example` is now the BOOTSTRAP FLOOR only, so the service
 *     topology lives in `apps/api/.env.sample` (TASK-584: renamed from
 *     `apps/api/.env.example` for naming consistency with the other
 *     per-service `.env.sample` files).
 *
 * ── WHAT IT CHECKS NOW ───────────────────────────────────────────────────────
 *  • The DEV port map is not restated here — it is READ from the setting
 *    descriptors (`apps/api/src/config`), so a port change in the declaration
 *    cannot leave this test asserting the old number.
 *  • `.env.test` = DEV + 100 for every application port.
 *  • `apps/api/.env.prod` addresses services by hostname, not localhost
 *    (TASK-584: relocated from the monorepo-root `.env.production`).
 *  • The source-level defaults (`ConfigService`, `IAppConfig`) still match.
 *  • Retired services (`FEDL_*`) and stale ports (5002/5004/5006/8001…) stay gone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { API_ENV_DESCRIPTORS } from '../config';
import { toEnvVarName } from '@arcaai/applications';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
}

function envFileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(PROJECT_ROOT, relativePath));
}

function readEnvFile(relativePath: string): string {
    return readFile(path.join(PROJECT_ROOT, relativePath));
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

/** The declared DEV port for a variable, straight from its descriptor. */
function declaredPort(name: string): number {
    const descriptor = API_ENV_DESCRIPTORS.find((d) => toEnvVarName(d.key) === name);
    expect(descriptor, `${name} is not declared in apps/api/src/config`).toBeDefined();
    const value = Number(descriptor!.default);
    expect(Number.isInteger(value), `${name} has no numeric declared default`).toBe(true);
    return value;
}

/**
 * Every application port, by variable name. The VALUES come from the
 * declarations; only the membership of this list is stated here.
 */
const PORT_VARS = ['PORT', 'API_PORT', 'STT_PORT', 'SMR_PORT', 'GUARDRAIL_PORT', 'NLP_PORT', 'TTS_PORT', 'HARNESS_PORT'] as const;

/** `<VAR>_URL` ⇄ `<VAR>_PORT` pairs the gateway resolves. */
const URL_TO_PORT_VAR: ReadonlyArray<readonly [string, string]> = [
    ['API_URL', 'API_PORT'],
    ['STT_URL', 'STT_PORT'],
    ['SMR_URL', 'SMR_PORT'],
    ['GUARDRAIL_URL', 'GUARDRAIL_PORT'],
    ['NLP_URL', 'NLP_PORT'],
    ['TTS_URL', 'TTS_PORT'],
    ['HARNESS_URL', 'HARNESS_PORT'],
];

/** Test application ports are DEV + 100 (TASK-557, commit d84f538e). */
const TEST_PORT_OFFSET = 100;

// ─── 1. The declared DEV topology ────────────────────────────────────────────

describe('Port topology: the declared DEV ports', () => {
    it('declares all 8 application port variables', () => {
        for (const name of PORT_VARS) expect(() => declaredPort(name)).not.toThrow();
    });

    it('assigns every service a unique port', () => {
        // PORT and API_PORT are deliberately the same gateway port.
        const ports = PORT_VARS.filter((n) => n !== 'API_PORT').map(declaredPort);
        expect(new Set(ports).size).toBe(ports.length);
    });

    it('keeps every service port in the 886x range', () => {
        for (const name of PORT_VARS) {
            const port = declaredPort(name);
            expect(port, name).toBeGreaterThanOrEqual(8861);
            expect(port, name).toBeLessThanOrEqual(8868);
        }
    });

    it('agrees that PORT and API_PORT address the same gateway', () => {
        expect(declaredPort('API_PORT')).toBe(declaredPort('PORT'));
    });

    it('never collides with an infrastructure port', () => {
        const infraPorts = [5432, 6379, 9092, 9000, 6333, 1883, 4317, 8200, 7233];
        for (const name of PORT_VARS) expect(infraPorts, name).not.toContain(declaredPort(name));
    });
});

// ─── 2. apps/api/.env.sample — the generated topology document ───────────────

describe('Port topology: apps/api/.env.sample matches the declarations', () => {
    const content = readEnvFile('apps/api/.env.sample');

    for (const name of PORT_VARS) {
        // PORT itself belongs to the bootstrap floor (root .env.example).
        if (name === 'PORT') continue;
        it(`${name} equals its declared default`, () => {
            expect(getEnvValue(content, name)).toBe(String(declaredPort(name)));
        });
    }

    for (const [urlVar, portVar] of URL_TO_PORT_VAR) {
        if (urlVar === 'API_URL') continue; // the gateway does not declare its own URL
        it(`${urlVar} points at the ${portVar} port`, () => {
            const url = getEnvValue(content, urlVar);
            expect(url, `${urlVar} missing from apps/api/.env.sample`).not.toBeNull();
            expect(new URL(url!).port).toBe(String(declaredPort(portVar)));
        });
    }
});

// ─── 3. The root example is the bootstrap floor ──────────────────────────────

describe('Port topology: root .env.example carries the bootstrap floor only', () => {
    const content = readEnvFile('.env.example');

    it('declares PORT (the gateway is part of the floor)', () => {
        expect(getEnvValue(content, 'PORT')).toBe(String(declaredPort('PORT')));
    });

    it('declares no downstream service URL — those live in apps/api/.env.sample', () => {
        for (const [urlVar] of URL_TO_PORT_VAR) {
            if (urlVar === 'API_URL') continue;
            expect(envVarExists(content, urlVar), urlVar).toBe(false);
        }
    });
});

// ─── 4. .env.test runs the DEV + 100 scheme ──────────────────────────────────

describe('Port topology: .env.test is DEV + 100 (TASK-557)', () => {
    const content = readEnvFile('.env.test');

    for (const name of PORT_VARS) {
        it(`${name} is the dev port plus ${TEST_PORT_OFFSET}`, () => {
            const value = getEnvValue(content, name);
            expect(value, `${name} missing from .env.test`).not.toBeNull();
            expect(Number(value)).toBe(declaredPort(name) + TEST_PORT_OFFSET);
        });
    }

    for (const [urlVar, portVar] of URL_TO_PORT_VAR) {
        it(`${urlVar} points at the test ${portVar}`, () => {
            const url = getEnvValue(content, urlVar);
            expect(url, `${urlVar} missing from .env.test`).not.toBeNull();
            expect(new URL(url!).port).toBe(String(declaredPort(portVar) + TEST_PORT_OFFSET));
        });
    }

    it('uses a distinct node inspector endpoint so a test gateway can debug beside a dev one', () => {
        expect(getEnvValue(content, 'API_INSPECT_HOSTPORT')).not.toBe(getEnvValue(readEnvFile('apps/api/.env.sample'), 'API_INSPECT_HOSTPORT'));
    });

    it('isolates the admin console port too', () => {
        expect(getEnvValue(content, 'ADMIN_PORT')).toBe(String(5176 + TEST_PORT_OFFSET));
    });
});

// ─── 5. Local, gitignored dev file — checked only when it exists ─────────────
// `.env.dev` was untracked by TASK-558 lane A (it was committed with real
// credentials). A clean clone and every CI job have none, so these assertions
// are conditional BY DESIGN, not by accident.

describe('Port topology: .env.dev, when a developer has one, uses the DEV ports', () => {
    const exists = envFileExists('.env.dev');
    const content = exists ? readEnvFile('.env.dev') : '';

    it.runIf(exists)('uses the declared DEV port for every application port it defines', () => {
        for (const name of PORT_VARS) {
            const value = getEnvValue(content, name);
            if (value === null) continue;
            expect(Number(value), name).toBe(declaredPort(name));
        }
    });

    it.runIf(exists)('points every service URL at its DEV port', () => {
        for (const [urlVar, portVar] of URL_TO_PORT_VAR) {
            const url = getEnvValue(content, urlVar);
            if (url === null) continue;
            expect(new URL(url).port, urlVar).toBe(String(declaredPort(portVar)));
        }
    });
});

// ─── 6. apps/api/.env.prod addresses services by hostname ────────────────────
// TASK-584: relocated from the monorepo-root `.env.production` — production
// reference templates now live per-service, not at the monorepo root.

describe('Port topology: apps/api/.env.prod uses service hostnames, not localhost', () => {
    const content = readEnvFile('apps/api/.env.prod');
    const expectedHost: ReadonlyArray<readonly [string, string]> = [
        ['API_URL', 'api'],
        ['GUARDRAIL_URL', 'guardrail'],
        ['SMR_URL', 'smr'],
        ['NLP_URL', 'nlp'],
        ['HARNESS_URL', 'harness'],
    ];

    for (const [urlVar, host] of expectedHost) {
        it(`${urlVar} resolves to the "${host}" service`, () => {
            const url = getEnvValue(content, urlVar);
            expect(url, `${urlVar} missing from apps/api/.env.prod`).not.toBeNull();
            expect(new URL(url!).hostname).toBe(host);
        });
    }

    for (const [urlVar, portVar] of URL_TO_PORT_VAR) {
        if (urlVar === 'API_URL') continue;
        it(`${urlVar} keeps the ${portVar} port`, () => {
            const url = getEnvValue(content, urlVar);
            if (url === null) return;
            expect(new URL(url).port).toBe(String(declaredPort(portVar)));
        });
    }
});

// ─── 7. Retired services and stale ports stay gone ───────────────────────────

describe('Port topology: retired services and stale ports', () => {
    const envFiles = ['.env.example', '.env.test', 'apps/api/.env.sample', 'apps/api/.env.prod'].filter(envFileExists);

    // apps/fedl and the legacy apps/tts (which owned 8863) were removed; 8863 is
    // Guardrail and 8866 is the Clinical Documentation Harness.
    const retired = ['FEDL_PORT', 'FEDL_URL', 'SMR_SERVICE_URL_HTTP', 'NLP_SERVICE_URL_HTTP'];
    const stalePorts = ['5002', '5004', '5005', '5006', '8001', '8002', '8003'];

    for (const file of envFiles) {
        it(`${file} declares no retired variable`, () => {
            const content = readEnvFile(file);
            for (const name of retired) expect(envVarExists(content, name), name).toBe(false);
        });

        it(`${file} references no stale service port`, () => {
            const content = readEnvFile(file);
            for (const [urlVar] of URL_TO_PORT_VAR) {
                const url = getEnvValue(content, urlVar);
                if (url === null) continue;
                expect(stalePorts, `${urlVar}=${url}`).not.toContain(new URL(url).port);
            }
            for (const portVar of PORT_VARS) {
                const value = getEnvValue(content, portVar);
                if (value === null) continue;
                expect(stalePorts, portVar).not.toContain(value);
            }
        });
    }
});

// ─── 8. Source-level defaults ────────────────────────────────────────────────

describe('Port topology: ConfigService defaults', () => {
    const configServicePath = path.resolve(PROJECT_ROOT, 'packages/applications/src/services/baseServices/_meta/config/config.service.ts');
    const source = readFile(configServicePath);

    const expected: ReadonlyArray<readonly [string, string]> = [
        ['PORT', "'8868'"],
        ['SMR_PORT', "'8862'"],
        ['NLP_PORT', "'8864'"],
        ['TTS_PORT', "'8865'"],
    ];

    for (const [name, literal] of expected) {
        it(`${name} defaults to ${literal}`, () => {
            expect(source).toMatch(new RegExp(`${name}.*\\|\\|.*${literal.replace(/'/g, "['\"]")}`));
        });
    }

    const urlDefaults: ReadonlyArray<readonly [string, number]> = [
        ['STT_URL', 8861],
        ['SMR_URL', 8862],
        ['GUARDRAIL_URL', 8863],
        ['NLP_URL', 8864],
        ['TTS_URL', 8865],
        ['HARNESS_URL', 8866],
    ];

    for (const [name, port] of urlDefaults) {
        it(`${name} defaults to localhost:${port}`, () => {
            expect(source).toMatch(new RegExp(`${name}.*\\|\\|.*http://localhost:${port}`));
        });
    }

    it('keeps no pre-886x default', () => {
        for (const stale of ['5002', '5004', '5006', '8002', '8003']) {
            expect(source, stale).not.toMatch(new RegExp(`localhost:${stale}\\b`));
            expect(source, stale).not.toMatch(new RegExp(`\\|\\|\\s*['"]${stale}['"]`));
        }
    });
});

describe('Port topology: ServiceHealthMonitoring defaults', () => {
    const source = readFile(path.resolve(PROJECT_ROOT, 'packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts'));

    for (const port of [8862, 8863, 8865, 8866]) {
        it(`probes localhost:${port}`, () => {
            expect(source).toMatch(new RegExp(`http://localhost:${port}`));
        });
    }
});

describe('Port topology: IAppConfig declares the full topology', () => {
    const content = readFile(path.resolve(PROJECT_ROOT, 'packages/domains/src/interfaces/IAppConfig.ts'));

    const required = ['PORT', 'STT_URL', 'SMR_PORT', 'SMR_URL', 'NLP_PORT', 'NLP_URL', 'GUARDRAIL_URL', 'HARNESS_URL', 'TTS_PORT', 'TTS_URL'];

    for (const prop of required) {
        it(`declares ${prop} as required`, () => {
            const line = content.split('\n').find((l) => new RegExp(`^\\s*${prop}\\s*[?:]`).test(l));
            expect(line, `${prop} missing from IAppConfig`).toBeDefined();
            expect(line, `${prop} must not be optional`).not.toMatch(new RegExp(`${prop}\\s*\\?:`));
        });
    }

    for (const prop of ['FEDL_PORT', 'FEDL_URL']) {
        it(`does not declare removed ${prop}`, () => {
            expect(content).not.toMatch(new RegExp(`^\\s*${prop}\\s*[?:]`, 'm'));
        });
    }
});
