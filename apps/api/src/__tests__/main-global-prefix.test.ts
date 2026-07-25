import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reduced after module removal — internal route exclusion tests removed
 * since stt (the only internal route consumer) was removed.
 */

const mainTsSource = readFileSync(
    join(__dirname, '..', 'main.ts'),
    'utf-8',
);

// ─── CSP Middleware Path Matching ─────────────────────────────────────────

describe('CSP middleware path matching', () => {
    function shouldApplyCsp(path: string): boolean {
        return path.startsWith('/api/v1/docs');
    }

    describe('paths that should receive CSP headers', () => {
        it('should apply CSP to /api/v1/docs', () => {
            expect(shouldApplyCsp('/api/v1/docs')).toBe(true);
        });

        it('should apply CSP to /api/v1/docs/', () => {
            expect(shouldApplyCsp('/api/v1/docs/')).toBe(true);
        });

        it('should apply CSP to /api/v1/docs/swagger-ui.css', () => {
            expect(shouldApplyCsp('/api/v1/docs/swagger-ui.css')).toBe(true);
        });

        it('should apply CSP to /api/v1/docs-json', () => {
            expect(shouldApplyCsp('/api/v1/docs-json')).toBe(true);
        });
    });

    describe('paths that should NOT receive CSP headers', () => {
        it('should not apply CSP to /api/v1/health', () => {
            expect(shouldApplyCsp('/api/v1/health')).toBe(false);
        });

        it('should not apply CSP to /api/v1/auth/login', () => {
            expect(shouldApplyCsp('/api/v1/auth/login')).toBe(false);
        });

        it('should not apply CSP to /metrics', () => {
            expect(shouldApplyCsp('/metrics')).toBe(false);
        });

        it('should not apply CSP to root /', () => {
            expect(shouldApplyCsp('/')).toBe(false);
        });

        it('should not apply CSP to old /api path', () => {
            expect(shouldApplyCsp('/api')).toBe(false);
        });

        it('should not apply CSP to old /api/docs path', () => {
            expect(shouldApplyCsp('/api/docs')).toBe(false);
        });
    });
});

// ─── Route Composition ───────────────────────────────────────────────────

describe('Route composition with api/v1 prefix', () => {
    const globalPrefix = 'api/v1';

    function resolveRoute(controllerPath: string): string {
        return `/${globalPrefix}/${controllerPath}`;
    }

    describe('standard routes produce correct URLs', () => {
        const cases: [string, string][] = [
            ['health', '/api/v1/health'],
            ['auth', '/api/v1/auth'],
            ['users', '/api/v1/users'],
            ['admin/settings', '/api/v1/admin/settings'],
            ['admin/tenants', '/api/v1/admin/tenants'],
            ['admin/api-keys', '/api/v1/admin/api-keys'],
            ['admin/audit-logs', '/api/v1/admin/audit-logs'],
            ['admin/rbac/roles', '/api/v1/admin/rbac/roles'],
            ['admin/rbac/policies', '/api/v1/admin/rbac/policies'],
            ['monitoring', '/api/v1/monitoring'],
            ['storage', '/api/v1/storage'],
        ];

        it.each(cases)(
            'controller "%s" should resolve to %s',
            (controllerPath, expectedUrl) => {
                expect(resolveRoute(controllerPath)).toBe(expectedUrl);
            },
        );
    });

    describe('double-prefix regression guard', () => {
        it('should NOT produce /api/api/v1/ double prefix', () => {
            const result = resolveRoute('admin/tenants');
            expect(result).not.toContain('/api/api/');
        });

        it('should NOT produce /api/v1/api/v1/ when controller has no extra prefix', () => {
            const result = resolveRoute('health');
            expect(result).not.toMatch(/\/api\/v1\/api\/v1\//);
        });
    });
});

// ─── Source-Level Regression Guards ───────────────────────────────────────

describe('main.ts configuration regression guards', () => {
    describe('global prefix', () => {
        it('should declare globalPrefix as api/v1', () => {
            const match = mainTsSource.match(/const globalPrefix\s*=\s*['"](.+?)['"]/);
            expect(match).not.toBeNull();
            expect(match![1]).toBe('api/v1');
        });

        it('should not use the old "api" prefix (without /v1)', () => {
            const oldPrefixPattern = /const globalPrefix\s*=\s*['"]api['"]\s*;/;
            expect(mainTsSource).not.toMatch(oldPrefixPattern);
        });
    });

    describe('prefix exclusions', () => {
        it('should exclude /metrics', () => {
            expect(mainTsSource).toContain("'/metrics'");
        });
    });

    describe('swagger path', () => {
        it('should serve swagger at api/v1/docs', () => {
            const match = mainTsSource.match(/SwaggerModule\.setup\(\s*['"](.+?)['"]/);
            expect(match).not.toBeNull();
            expect(match![1]).toBe('api/v1/docs');
        });

        it('should not serve swagger at old "api" path', () => {
            expect(mainTsSource).not.toMatch(/SwaggerModule\.setup\(\s*['"]api['"]\s*,/);
        });
    });

    describe('CSP path check', () => {
        it('should use startsWith for /api/v1/docs', () => {
            expect(mainTsSource).toContain("req.path.startsWith('/api/v1/docs')");
        });

        it('should not reference old /api path in CSP condition', () => {
            expect(mainTsSource).not.toMatch(/req\.path\s*===\s*['"]\/api['"]/);
        });

        it('should not reference old /api/docs path in CSP condition', () => {
            expect(mainTsSource).not.toMatch(/startsWith\(\s*['"]\/api\/docs['"]\)/);
        });
    });

    // TASK-558 lane D moved the four pre-bootstrap `process.env` reads (PORT,
    // LOG_LEVEL, SHUTDOWN_*_MS, CORS_ALLOWED_ORIGINS) behind the validated env
    // schema (plan §4 B5), so the source no longer carries an inline `|| 8868`
    // fallback. The DEFAULT itself did not change — it is now declared on the
    // `port` descriptor and asserted behaviourally in
    // `src/config/__tests__/env.schema.test.ts` ("applies the descriptor default
    // when the var is absent" → 8868), which is a stronger guard than a regex
    // over the source. What main.ts must still guarantee is that it reads the
    // port from the VALIDATED object rather than raw `process.env`.
    describe('port resolution', () => {
        it('should take the port from the validated env schema, not raw process.env', () => {
            expect(mainTsSource).toMatch(/const port\s*=\s*env\.PORT/);
            expect(mainTsSource).not.toMatch(/const port\s*=\s*process\.env\.PORT/);
        });

        it('should validate the environment before NestFactory.create()', () => {
            // Match the STATEMENTS, not the words: both names also appear in the
            // seam comment above them.
            const validateAt = mainTsSource.indexOf('const env = apiEnv();');
            const createAt = mainTsSource.indexOf('await NestFactory.create(');
            expect(validateAt, 'main.ts must call apiEnv() at the schema seam').toBeGreaterThan(-1);
            expect(createAt).toBeGreaterThan(-1);
            expect(validateAt).toBeLessThan(createAt);
        });

        it('should not reintroduce the old default port 3000', () => {
            expect(mainTsSource).not.toMatch(/const port\s*=\s*[^;]*3000/);
        });
    });

    describe('startup log URLs', () => {
        it('should log swagger URL with /api/v1/docs', () => {
            expect(mainTsSource).toMatch(/swaggerUrl:\s*`[^`]*\/api\/v1\/docs`/);
        });

        it('should log health URL with /api/v1/health', () => {
            expect(mainTsSource).toMatch(/healthUrl:\s*`[^`]*\/api\/v1\/health`/);
        });

        it('should not log old swagger URL without /v1/', () => {
            expect(mainTsSource).not.toMatch(/swaggerUrl:\s*`[^`]*\/api`\s*$/m);
        });

        it('should not log old health URL /api/health (without /v1/)', () => {
            expect(mainTsSource).not.toMatch(/healthUrl:\s*`[^`]*\/api\/health`/);
        });
    });
});

// ─── Prefix Exclusion Config Structure ────────────────────────────────────

describe('NestJS setGlobalPrefix exclusion config structure', () => {
    it('string exclusion format is valid ("/metrics")', () => {
        const stringExclusion = '/metrics';
        expect(typeof stringExclusion).toBe('string');
        expect(stringExclusion.startsWith('/')).toBe(true);
    });
});
