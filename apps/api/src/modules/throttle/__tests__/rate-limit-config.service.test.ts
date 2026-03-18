/**
 * RateLimitConfigService production import tests (TDD RED phase)
 *
 * These tests import the REAL production service and verify
 * it implements the expected contract. They will FAIL until
 * the production module is created.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitConfigService } from '../rate-limit-config.service';

describe('RateLimitConfigService (production)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.stubEnv('RATE_LIMIT_ENABLED', undefined as any);
        vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', undefined as any);
        vi.stubEnv('RATE_LIMIT_WINDOW_MS', undefined as any);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('isEnabled', () => {
        it('should return true by default', () => {
            const service = new RateLimitConfigService();
            expect(service.isEnabled()).toBe(true);
        });

        it('should return false when RATE_LIMIT_ENABLED is "false"', () => {
            vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
            const service = new RateLimitConfigService();
            expect(service.isEnabled()).toBe(false);
        });
    });

    describe('getThrottlers', () => {
        it('should return four named throttlers with correct defaults', () => {
            const service = new RateLimitConfigService();
            const throttlers = service.getThrottlers();

            expect(throttlers).toHaveLength(4);
            expect(throttlers.map(t => t.name)).toEqual(['default', 'strict', 'heavy', 'relaxed']);
        });

        it('should return default throttler with 100 req / 60s', () => {
            const service = new RateLimitConfigService();
            const def = service.getThrottlers().find(t => t.name === 'default');
            expect(def).toEqual({ name: 'default', ttl: 60000, limit: 100 });
        });

        it('should return strict throttler with 10 req / 60s', () => {
            const service = new RateLimitConfigService();
            const strict = service.getThrottlers().find(t => t.name === 'strict');
            expect(strict).toEqual({ name: 'strict', ttl: 60000, limit: 10 });
        });

        it('should return heavy throttler with 20 req / 60s', () => {
            const service = new RateLimitConfigService();
            const heavy = service.getThrottlers().find(t => t.name === 'heavy');
            expect(heavy).toEqual({ name: 'heavy', ttl: 60000, limit: 20 });
        });

        it('should return relaxed throttler with 300 req / 60s', () => {
            const service = new RateLimitConfigService();
            const relaxed = service.getThrottlers().find(t => t.name === 'relaxed');
            expect(relaxed).toEqual({ name: 'relaxed', ttl: 60000, limit: 300 });
        });

        it('should respect RATE_LIMIT_MAX_REQUESTS env override for default', () => {
            vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '250');
            const service = new RateLimitConfigService();
            const def = service.getThrottlers().find(t => t.name === 'default');
            expect(def?.limit).toBe(250);
        });

        it('should respect RATE_LIMIT_WINDOW_MS env override for default', () => {
            vi.stubEnv('RATE_LIMIT_WINDOW_MS', '120000');
            const service = new RateLimitConfigService();
            const def = service.getThrottlers().find(t => t.name === 'default');
            expect(def?.ttl).toBe(120000);
        });
    });

    describe('getThrottlerModuleConfig', () => {
        it('should return array of throttler configs suitable for ThrottlerModule.forRoot()', () => {
            const service = new RateLimitConfigService();
            const config = service.getThrottlerModuleConfig();

            expect(Array.isArray(config)).toBe(true);
            expect(config).toHaveLength(4);
            for (const entry of config) {
                expect(entry).toHaveProperty('name');
                expect(entry).toHaveProperty('ttl');
                expect(entry).toHaveProperty('limit');
                expect(typeof entry.name).toBe('string');
                expect(typeof entry.ttl).toBe('number');
                expect(typeof entry.limit).toBe('number');
            }
        });
    });
});
