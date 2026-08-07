/**
 * @arcaai/vox - Deployment environment resolution tests
 *
 * The regression these lock down: a staging deploy is BUILT with
 * NODE_ENV=production by every browser bundler, so a NODE_ENV-only gate
 * silently disables the monitoring transports on staging.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isProductionEnvironment } from '../environment';

describe('isProductionEnvironment', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('declared environment wins over NODE_ENV', () => {
    it('treats an explicit staging deploy as non-production even when built with NODE_ENV=production', () => {
      process.env.NODE_ENV = 'production';
      expect(isProductionEnvironment('staging')).toBe(false);
    });

    it('treats an explicit production deploy as production even in a dev build', () => {
      process.env.NODE_ENV = 'development';
      expect(isProductionEnvironment('production')).toBe(true);
    });

    it.each(['production', 'PRODUCTION', 'Prod', 'prod', 'live', 'LIVE'])('treats %s as production', (name) => {
      expect(isProductionEnvironment(name)).toBe(true);
    });

    it.each(['staging', 'stage', 'development', 'dev', 'test', 'qa', 'preview'])('treats %s as non-production', (name) => {
      expect(isProductionEnvironment(name)).toBe(false);
    });

    it('ignores surrounding whitespace', () => {
      expect(isProductionEnvironment('  production  ')).toBe(true);
      expect(isProductionEnvironment('  staging  ')).toBe(false);
    });
  });

  describe('NODE_ENV fallback when nothing is declared', () => {
    it('falls back to production when NODE_ENV=production', () => {
      process.env.NODE_ENV = 'production';
      expect(isProductionEnvironment(undefined)).toBe(true);
      expect(isProductionEnvironment('')).toBe(true);
      expect(isProductionEnvironment('   ')).toBe(true);
    });

    it('falls back to non-production otherwise', () => {
      process.env.NODE_ENV = 'development';
      expect(isProductionEnvironment(undefined)).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(isProductionEnvironment(undefined)).toBe(false);
    });
  });
});
