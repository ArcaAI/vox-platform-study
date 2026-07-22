import { describe, expect, it } from 'vitest';

import { buildSwaggerConfig } from '../swagger.config';

/**
 * Swagger `addApiKey(...)` registration.
 *
 * Several controllers carry `@ApiSecurity('api-key')` (e.g. the internal STT
 * controller); without a matching `'api-key'` scheme in the generated
 * OpenAPI spec, UIs (Swagger / Stoplight / Postman import) render the lock
 * icon as undefined or silently drop the requirement.
 *
 * `buildSwaggerConfig` registers an `apiKey`-in-header scheme
 * (`name: 'x-api-key'`) under the same security name (`'api-key'`) so the
 * existing controller annotations resolve.
 */
describe('buildSwaggerConfig', () => {
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
