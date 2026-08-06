import { afterEach, describe, expect, it } from 'vitest';

import { getCorsOrigins, isOriginAllowed, setPlatformCorsOriginsResolver } from '../cors.config';

/** Resolve the callback returned by `getCorsOrigins` to its boolean decision. */
function allows(nodeEnv: string, origin: string | undefined): boolean {
  const resolver = getCorsOrigins(nodeEnv) as (o: string | undefined, cb: (e: Error | null, allow?: boolean) => void) => void;
  let allowed = false;
  resolver(origin, (_err, value) => {
    allowed = value === true;
  });
  return allowed;
}

describe('getCorsOrigins', () => {
  afterEach(() => {
    setPlatformCorsOriginsResolver(null);
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  describe('development', () => {
    it('returns a callback (never `true`/`*`, which is illegal with credentials)', () => {
      expect(typeof getCorsOrigins('development')).toBe('function');
    });

    it.each([
      ['http://localhost:3000'],
      ['http://localhost:5173'],
      ['http://127.0.0.1:5173'],
      ['https://compat-playground.taphuynh.dev'],
      ['https://arcaai-u2204.bcmch.org'],
      ['https://arcaai-staging.bcmch.org'],
      ['https://mi-preproduction.bcmch.org:4433'],
      ['http://192.168.1.10:8080'],
    ])('allows %s', (origin) => {
      expect(allows('development', origin)).toBe(true);
    });
  });

  describe('CORS_ALLOWED_ORIGINS applies in every environment', () => {
    it.each(['staging', 'production'])('honours the allow-list in %s', (nodeEnv) => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://arcaai-u2204.bcmch.org, https://mi-preproduction.bcmch.org:4433';

      expect(isOriginAllowed('https://arcaai-u2204.bcmch.org', nodeEnv)).toBe(true);
      expect(isOriginAllowed('https://mi-preproduction.bcmch.org:4433', nodeEnv)).toBe(true);
    });

    it('still rejects an unlisted origin in staging', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://arcaai-u2204.bcmch.org';
      expect(isOriginAllowed('https://evil.example', 'staging')).toBe(false);
    });
  });

  describe('production', () => {
    it('returns a callback (unchanged behaviour)', () => {
      expect(typeof getCorsOrigins('production')).toBe('function');
    });
  });

  describe('staging', () => {
    it('returns a callback (unchanged behaviour)', () => {
      expect(typeof getCorsOrigins('staging')).toBe('function');
    });
  });
});
