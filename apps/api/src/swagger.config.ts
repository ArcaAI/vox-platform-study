import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

import { applyOperationSecurity } from './openapi/operation-security';
import { API_TAGS } from './openapi/tags';

/**
 * Swagger `DocumentBuilder` for the API gateway.
 *
 * Extracted from `main.ts` so the configured metadata, security schemes and
 * tag taxonomy can be asserted in a unit test (an inline
 * `new DocumentBuilder()...` in `main.ts` can't be tested without booting Nest).
 *
 * This one builder feeds BOTH consumers, which is the point — they cannot drift:
 *
 *   - `main.ts` -> the dev-only Swagger UI at `/api/v1/docs`
 *   - `scripts/emit-openapi.ts` -> the committed `apps/api/openapi.json`, which
 * is the input to `packages/vox-node-codegen` and to the admin
 *     console's developer portal.
 *
 * ## `info.version` is the CONTRACT version, not the build version
 *
 * It is deliberately a constant. `openapi.json` is a committed, drift-gated
 * artifact: a value derived from `build-info.json`, a git tag, or the
 * environment would make the emitted document differ per machine and per
 * pipeline, so `generate-vox-node-admin-check` and `openapi-coverage-check`
 * would fail on a clean tree. It is also the semantically correct reading —
 * OpenAPI's `info.version` describes the API DOCUMENT, not the deployment.
 *
 * The deployment identity (release tag, commit sha, build time) is an
 * immutable property of the IMAGE, carried in `/app/build-info.json` and read
 * at runtime through `BuildInfoService`. The developer portal renders it from
 * there. See `.claude/rules/09-infrastructure-devops.md` §Release Versioning
 * build identity belongs to none of the configuration tiers, and must not be
 * baked into a document that is supposed to be reproducible.
 *
 * ## Security schemes
 *
 * One per credential class the gateway actually accepts, so a lock icon in the
 * reference resolves to something real. All three are registered even though
 * individual routes select among them, because a scheme referenced by
 * `@ApiSecurity(...)` with no matching `securitySchemes` entry renders as
 * undefined and is silently dropped by generated clients:
 *
 * | Scheme name | Header | Class |
 * |---|---|---|
 * | `bearer` | `Authorization: Bearer <jwt>` | user JWT (`@nestjs/passport` flow) |
 * | `api-key` | `x-api-key` | tenant API key — the business plane only; every `/admin/*` route carries `@ForbidApiKey()` |
 * | `service-account` | `x-service-account-token` | platform machine identity — the ONLY path to the administration plane |
 *
 * WHICH of the three a given operation advertises is not decided here and is
 * not decided by `@Api*` decorators either — see
 * `createHopeOpenApiDocument()` below and `openapi/operation-security.ts`.
 *
 * Header names are pinned to the live readers: `x-api-key` to
 * `ApiKeyService.extractApiKeyFromRequest()`, and `x-service-account-token` to
 * `SERVICE_ACCOUNT_TOKEN_HEADER` in
 * `packages/applications/src/authorization/unified-auth.guard.ts`. A rename
 * there without a rename here produces a reference that documents a header
 * nothing reads; `swagger.config.test.ts` asserts the pinning.
 *
 * ## No `servers` entry
 *
 * Paths already carry the `/api/v1` global prefix, and a server URL is
 * environment-specific — baking one into a committed, drift-gated artifact
 * would either be wrong everywhere or make the emitted document
 * environment-dependent. Consumers know their own gateway origin.
 */

/** The API document's own version. See the header — deliberately NOT the release tag. */
export const OPENAPI_CONTRACT_VERSION = '1.0.0';

const DESCRIPTION = [
  'The HOPE platform gateway — multi-tenant clinical consultation transcription, medical NLP,',
  'LLM summarization, guardrails, and clinical documentation.',
  '',
  '## Planes',
  '',
  'Routes belong to one of two planes, and the distinction decides which credentials can reach them.',
  '',
  '- **Business plane** — tenant-facing. Reachable with a user JWT, a tenant **API key**, or a service-account token.',
  '- **Administration plane** (`/api/v1/admin/**`) — reachable with a user JWT or a **service-account token** only.',
  '  Every route carries `@ForbidApiKey()`, enforced BEFORE scope and ability checks, so a broadly-scoped API key',
  '  is rejected there unconditionally.',
  '',
  'Scopes bind the *credential*; abilities bind the *human* the credential acts for. They compose as AND —',
  'a credential can never exceed the user it is bound to.',
  '',
  '## Errors',
  '',
  '| Status | Meaning |',
  '| --- | --- |',
  '| `401` | No credential, or the credential is expired, revoked, or malformed. |',
  '| `403` | A privilege boundary: the credential class, scope, or ability is insufficient. |',
  '| `404` | Either the resource does not exist, **or it belongs to another tenant**. The gateway returns 404 rather than 403 across a tenant boundary so resource existence is never disclosed. Treat it as "not yours", not "wrong URL". |',
  "| `409` | A conflict — commonly a quota ceiling from the tenant's plan entitlements. |",
  '| `412` | Optimistic-concurrency drift: your `If-Match` no longer matches the current `ETag`. Re-read and retry. |',
  '| `428` | This route requires `If-Match` and you did not send one. Read the resource, take its `ETag`, resend. |',
  '| `429` | Rate limited. |',
  '',
  '## Optimistic concurrency',
  '',
  'Versioned resources return a strong `ETag`. To modify one, send it back as `If-Match`.',
  'Omitting the header is a `428`; sending a stale one is a `412`. Never retry a `412` blindly —',
  're-read the resource first, because someone else changed it.',
].join('\n');

export function buildSwaggerConfig(): DocumentBuilder {
  const builder = new DocumentBuilder()
    .setTitle('HOPE Platform API')
    .setDescription(DESCRIPTION)
    .setVersion(OPENAPI_CONTRACT_VERSION)
    // NOTE: `setContact(...)` and `setLicense(...)` are deliberately
    // NOT set. A developer-facing reference publishes whatever goes here, and
    // no support address or license URL for this API has been supplied by the
    // owner — the values that previously appeared in `swagger-config.test.ts`
    // (`support@arcaai.com`, `https://arcaai.com/license`) were invented by
    // that test and are referenced nowhere else in the repo. Add them here once
    // real ones exist; publishing a support channel that does not answer is
    // worse than publishing none.
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .addApiKey({ type: 'apiKey', name: 'x-service-account-token', in: 'header' }, 'service-account');

  // Order here IS the sidebar order in every renderer. `API_TAGS` is grouped by
  // plane, so business-plane groups lead and administration follows.
  for (const tag of API_TAGS) {
    builder.addTag(tag.name, tag.description);
  }

  return builder;
}

/**
 * Build the gateway's OpenAPI document — the ONE place it is produced.
 *
 * `SwaggerModule.createDocument` alone is not enough, because the explorer can
 * only see `@Api*` decorators: it cannot see `@ForbidApiKey()`,
 * `@RequiredScopes(...)` or `@Public()`, which is what actually decides who may
 * call a route. `applyOperationSecurity` closes that by deriving each
 * operation's `security` from the same authorization metadata
 * `UnifiedAuthGuard` enforces and `route-manifest.json` records. See
 * `openapi/operation-security.ts`.
 *
 * Both consumers call THIS, not `createDocument` directly:
 *
 *   - `main.ts` -> the dev-only Swagger UI at `/api/v1/docs`
 *   - `scripts/emit-openapi.ts` -> the committed `apps/api/openapi.json`
 *
 * A consumer that skipped it would publish a document whose lock icons name the
 * wrong credentials, which is the defect this function exists to end — so the
 * composition lives here rather than being repeated at each call site.
 */
export function createHopeOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig().build());
  applyOperationSecurity(document, app);
  return document;
}
