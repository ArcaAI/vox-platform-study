import { DocumentBuilder } from '@nestjs/swagger';

/**
 * TASK-310 E-8 (AC-8) — Swagger `DocumentBuilder` for the API gateway.
 *
 * Extracted from `main.ts` so the configured security schemes can be
 * asserted in a unit test (the previous inline `new DocumentBuilder()...`
 * couldn't be tested without booting Nest).
 *
 * Security schemes registered:
 *   - `bearer`   the existing JWT scheme (`@nestjs/passport` flow).
 *   - `api-key`  backs `@ApiSecurity('api-key')` on internal controllers
 *                (`stt-internal.controller.ts`). Pre-W7 the annotation had
 *                no matching `securitySchemes` entry, so the lock icon
 *                rendered as undefined / silently dropped in Swagger UI
 *                and the OpenAPI clients.
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
