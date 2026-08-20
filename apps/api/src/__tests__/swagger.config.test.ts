import { SERVICE_ACCOUNT_TOKEN_HEADER } from '@arcaai/applications';
import { describe, expect, it } from 'vitest';

import { API_TAGS } from '../openapi/tags';
import { buildSwaggerConfig, OPENAPI_CONTRACT_VERSION } from '../swagger.config';

/**
 * `buildSwaggerConfig` feeds BOTH the dev Swagger UI and the committed
 * `openapi.json` that `packages/vox-node-codegen` and the admin console's
 * developer portal consume, so its output is a contract.
 *
 * This file replaced `swagger-config.test.ts` (deleted in TASK-783), which
 * constructed its OWN `new DocumentBuilder()` inline and asserted on that —
 * it exercised `@nestjs/swagger`, never `buildSwaggerConfig`, so every
 * assertion passed no matter what this repo's config did. It was also the only
 * place `support@arcaai.com` and `https://arcaai.com/license` appeared; both
 * were invented by that test and are deliberately not published.
 */
describe('buildSwaggerConfig', () => {
  const document = buildSwaggerConfig().build();

  describe('security schemes — one per credential class the gateway accepts', () => {
    it('registers the bearer scheme for user JWTs', () => {
      const bearer = document.components?.securitySchemes?.['bearer'] as { type?: string; scheme?: string } | undefined;

      expect(bearer?.type).toBe('http');
      expect(bearer?.scheme).toBe('bearer');
    });

    it('registers the api-key scheme on the header ApiKeyService actually reads', () => {
      const apiKey = document.components?.securitySchemes?.['api-key'] as { type?: string; name?: string; in?: string } | undefined;

      expect(apiKey?.type).toBe('apiKey');
      expect(apiKey?.in).toBe('header');
      expect(apiKey?.name).toBe('x-api-key');
    });

    it('registers the service-account scheme pinned to SERVICE_ACCOUNT_TOKEN_HEADER', () => {
      const svc = document.components?.securitySchemes?.['service-account'] as { type?: string; name?: string; in?: string } | undefined;

      expect(svc?.type).toBe('apiKey');
      expect(svc?.in).toBe('header');
      // Pinned to the live reader, not to a string literal — a rename in
      // unified-auth.guard.ts fails here rather than silently producing a
      // reference that documents a header nothing reads.
      expect(svc?.name).toBe(SERVICE_ACCOUNT_TOKEN_HEADER);
    });
  });

  describe('document metadata', () => {
    it('carries a real title and a description that explains the plane split', () => {
      expect(document.info?.title).toBe('HOPE Platform API');
      expect(document.info?.description).toContain('Administration plane');
      expect(document.info?.description).toContain('Business plane');
    });

    it('documents the house error contract, including 404-over-403 and the OCC pair', () => {
      const description = document.info?.description ?? '';

      expect(description).toContain('`404`');
      expect(description).toContain('another tenant');
      expect(description).toContain('`428`');
      expect(description).toContain('`412`');
      expect(description).toContain('If-Match');
    });

    it('pins info.version to the CONTRACT version, not a build-derived value', () => {
      // `openapi.json` is committed and drift-gated. A version read from
      // build-info/git/env would differ per machine and break the gate on a
      // clean tree. See the swagger.config.ts header.
      expect(document.info?.version).toBe(OPENAPI_CONTRACT_VERSION);
      expect(OPENAPI_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('publishes no contact or license until real values exist', () => {
      expect(document.info?.contact ?? {}).toEqual({});
      expect(document.info?.license).toBeUndefined();
    });

    it('declares no servers — paths already carry the global prefix', () => {
      expect(document.servers ?? []).toEqual([]);
    });
  });

  describe('tag taxonomy', () => {
    it('populates the top-level tags array (empty before TASK-783)', () => {
      expect(document.tags?.length).toBe(API_TAGS.length);
      expect(document.tags?.length).toBeGreaterThan(0);
    });

    it('gives every tag a description', () => {
      const undescribed = (document.tags ?? []).filter((tag) => !tag.description?.trim());

      expect(undescribed).toEqual([]);
    });

    it('preserves API_TAGS order — it is the renderer sidebar order', () => {
      expect((document.tags ?? []).map((tag) => tag.name)).toEqual(API_TAGS.map((tag) => tag.name));
    });
  });
});
