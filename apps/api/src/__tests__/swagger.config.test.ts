import { describe, expect, it } from 'vitest';

import { buildSwaggerConfig } from '../swagger.config';

/**
 * TASK-310 E-8 (AC-8) — Swagger `addApiKey(...)` registration.
 *
 * Pre-W7 the bootstrap only called `.addBearerAuth()`. Several controllers
 * carry `@ApiSecurity('api-key')` (e.g. the internal STT controller), but
 * the generated OpenAPI spec had no `'api-key'` scheme to back them — UIs
 * (Swagger / Stoplight / Postman import) rendered the lock icon as
 * undefined or silently dropped the requirement.
 *
 * The fix registers an `apiKey`-in-header scheme (`name: 'x-api-key'`)
 * under the same security name (`'api-key'`) so the existing controller
 * annotations finally resolve.
 */
describe('buildSwaggerConfig (TASK-310 E-8 / AC-8)', () => {
  it('registers the bearer scheme', () => {
    const document = buildSwaggerConfig().build();

    expect(document.components?.securitySchemes?.['bearer']).toBeDefined();
    const bearer = document.components?.securitySchemes?.['bearer'] as { type?: string; scheme?: string };
    expect(bearer.type).toBe('http');
    expect(bearer.scheme).toBe('bearer');
  });

  it('registers the api-key scheme that backs @ApiSecurity("api-key")', () => {
    const document = buildSwaggerConfig().build();

    const apiKey = document.components?.securitySchemes?.['api-key'] as { type?: string; name?: string; in?: string } | undefined;
    expect(apiKey).toBeDefined();
    expect(apiKey?.type).toBe('apiKey');
    expect(apiKey?.name).toBe('x-api-key');
    expect(apiKey?.in).toBe('header');
  });

  it('keeps the existing document metadata (title / version / description)', () => {
    const document = buildSwaggerConfig().build();
    expect(document.info?.title).toBeTruthy();
    expect(document.info?.version).toBeTruthy();
    expect(document.info?.description).toBeTruthy();
  });
});
