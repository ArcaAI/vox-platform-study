import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Swagger `DocumentBuilder` for the API gateway.
 *
 * Extracted from `main.ts` so the configured security schemes can be
 * asserted in a unit test (an inline `new DocumentBuilder()...` in `main.ts`
 * can't be tested without booting Nest).
 *
 * Security schemes registered:
 *   - `bearer`   the existing JWT scheme (`@nestjs/passport` flow).
 *   - `api-key`  backs `@ApiSecurity('api-key')` on internal controllers
 *                (`stt-internal.controller.ts`) — without a matching
 *                `securitySchemes` entry the lock icon renders as undefined
 *                / silently drops in Swagger UI and the OpenAPI clients.
 *
 * Header name is pinned to `x-api-key` to match the live
 * `ApiKeyService.extractApiKeyFromRequest()` read in
 * `packages/applications/src/services/apiKey/apikey.service.ts`.
 */
export function buildSwaggerConfig(): DocumentBuilder {
  return new DocumentBuilder()
    .setTitle('Api')
    .setDescription('Main api backend')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key');
}
