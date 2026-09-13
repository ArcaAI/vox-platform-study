/**
 * Per-operation `security` for the gateway's OpenAPI document.
 *
 * ## What this fixes
 *
 * Before this module existed, every business operation in `openapi.json`
 * published `security: [{"bearer":[]},{"bearer":[]}]` — `bearer` listed TWICE,
 * on 647 of 665 operations — while the `api-key` and `service-account` schemes
 * `swagger.config.ts` registers were referenced by ZERO operations. The
 * reference therefore told a developer to present a JWT on the very routes
 * their tenant API key was minted for.
 *
 * The duplication was accumulation, not a typo: `@Authorize()`/`@AuthorizeAny()`
 * used to apply `ApiBearerAuth()` themselves, and 117 controllers additionally
 * carry a class-level `@ApiBearerAuth()`. `@nestjs/swagger` concatenates
 * class-level and method-level `API_SECURITY` metadata, so a controller with a
 * class-level `@ApiBearerAuth()`, a class-level `@CanManage(...)` and a
 * method-level `@CanRead(...)` emitted `bearer` three times.
 *
 * ## Why it is derived here rather than declared per decorator
 *
 * Which credential classes reach a route is NOT expressible as "whatever
 * `@Api*` decorators happened to accumulate", because two of the three answers
 * are SUBTRACTIVE: `@ForbidApiKey()` and `@ForbidServiceAccount()` refuse a
 * class outright, are checked BEFORE any scope check, and can sit at a
 * different decoration level than the `@RequiredScopes(...)` they override. A
 * decorator cannot reliably remove metadata another decorator added; a single
 * pass over the resolved metadata can.
 *
 * So this module reads the SAME metadata, the SAME way
 * (`Reflector.getAllAndOverride([methodRef, ControllerClass])`), that
 * `UnifiedAuthGuard` reads at request time and that
 * `apps/api/route-manifest.json` — the authorization ORACLE of
 * `.claude/rules/05-nestjs-api.md` §API Test Standard — is emitted from. The
 * published document is then a function of the oracle rather than something
 * that merely happens to agree with it, and
 * `src/__tests__/openapi-operation-security.artifact.test.ts` asserts that
 * identity for every documented operation.
 *
 * This is documentation only. Nothing here is read at request time, and no
 * guard, scope, ability or route changes shape because of it.
 */
import { METHOD_METADATA } from '@nestjs/common/constants';
import type { INestApplicationContext } from '@nestjs/common';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import {
  API_KEY_FORBIDDEN,
  API_KEY_REQUIRED_SCOPES,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SKIP_AUTH_KEY,
} from '@arcaai/applications';
import type { OpenAPIObject } from '@nestjs/swagger';
// Side-effect import — applies `@Public()` (`SKIP_AUTH_KEY`) to vendored
// third-party controllers we cannot decorate at the source (willsoto's
// `PrometheusController.index`, i.e. `/metrics`). Its own header requires EVERY
// route-walking code path to import it, and this is one: without it `/metrics`
// is walked as non-public and the reference tells a Prometheus scraper it needs
// a JWT to read an endpoint the gateway serves unauthenticated.
import '../bootstrap/third-party-public-routes';

/** `Authorization: Bearer <jwt>` — the interactive human. Registered in `swagger.config.ts`. */
export const SECURITY_SCHEME_BEARER = 'bearer';
/** `x-api-key` — a tenant API key. Business plane only. */
export const SECURITY_SCHEME_API_KEY = 'api-key';
/** `x-service-account-token` — the platform machine identity. */
export const SECURITY_SCHEME_SERVICE_ACCOUNT = 'service-account';

/**
 * The authorization facts one route carries, exactly as the guard resolves them.
 *
 * Structurally a subset of a `route-manifest.json` entry, deliberately: a
 * manifest row can be passed straight in, which is what lets the artifact test
 * check the emitted document against the oracle with no re-derivation.
 */
export interface RouteAuthorizationFacts {
  /** `@Public()` — mirrors the guard: `SKIP_AUTH_KEY` OR the legacy `'isPublic'` key. */
  isPublic: boolean;
  /** `@ForbidApiKey()`. Checked before scopes, so it is unconditional. */
  apiKeyForbidden: boolean;
  /** `@RequiredScopes(...)`. Empty = the API-key class is denied by default. */
  apiKeyScopes: string[];
  /** `@ForbidServiceAccount()`. Checked before scopes, so it is unconditional. */
  forbidServiceAccount: boolean;
  /** `@RequiredSvcScopes(...)`. Empty = the service-account class is denied by default. */
  svcScopes: string[];
}

/** One OpenAPI Security Requirement Object. */
export type SecurityRequirement = Record<string, string[]>;

/**
 * Which credential classes may reach this route, as the reference should
 * publish them. `undefined` means "no security requirement at all" — the route
 * is public — which is emitted by OMITTING `security`, matching what the
 * document already did for public routes.
 *
 * Mirrors `UnifiedAuthGuard`, and therefore `credentialsFor()` in
 * `scripts/gen-api-portal.ts`, which derives the same answer for the developer
 * portal's `x-hope-credentials` extension. The two must not drift: if this rule
 * ever changes, change both.
 *
 * Scope values are always EMPTY arrays. The OpenAPI 3 Security Requirement
 * Object permits a non-empty list only for `oauth2` / `openIdConnect` schemes;
 * all three of ours are `http`/`apiKey`, so listing `agent:invocation:write`
 * there would be spec-invalid. The scopes are published per operation by the
 * portal generator as `x-hope-api-key-scopes` / `x-hope-service-account-scopes`
 * and in the rendered credential note.
 */
export function securityForRoute(facts: RouteAuthorizationFacts): SecurityRequirement[] | undefined {
  // A public route needs no credential, whatever else it declares. Six public
  // routes carry an (inert) `@ForbidApiKey()` and none declares a scope, but the
  // ordering is stated rather than assumed: the guard returns before it looks.
  if (facts.isPublic) return undefined;

  // Every non-public route admits a user JWT. There is no `@ForbidJwt`, and the
  // deny-by-default boot audit refuses to start a gateway carrying a route with
  // neither `@Public()` nor a permission decorator — so the JWT path always exists.
  const security: SecurityRequirement[] = [{ [SECURITY_SCHEME_BEARER]: [] }];

  // Deny-by-default for both machine classes: NO scope declaration is a 403
  // expectation, not "unknown". And a forbid decorator wins over any scope,
  // because the guard checks it first.
  if (!facts.apiKeyForbidden && facts.apiKeyScopes.length > 0) {
    security.push({ [SECURITY_SCHEME_API_KEY]: [] });
  }
  if (!facts.forbidServiceAccount && facts.svcScopes.length > 0) {
    security.push({ [SECURITY_SCHEME_SERVICE_ACCOUNT]: [] });
  }

  return security;
}

/**
 * Walk the built application's controllers and resolve every route's security
 * requirement, keyed by the operation id Nest's default factory produces
 * (`<ControllerClass>_<handlerName>`).
 *
 * Deliberately narrower than `scripts/emit-route-manifest.ts`'s walk: it needs
 * no paths, no verbs and no ordering, only the authorization metadata per
 * (controller, handler) pair. Re-implementing the PATH half here to share code
 * with that script would put this documentation concern on the critical path of
 * the authorization oracle's own emission, which is not a trade worth making.
 */
export function collectRouteSecurity(app: INestApplicationContext): Map<string, SecurityRequirement[] | undefined> {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();
  const byOperationId = new Map<string, SecurityRequirement[] | undefined>();

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      for (const handler of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[handler];
        if (typeof methodRef !== 'function') continue;
        // No HTTP verb metadata = not a route (a helper method on the controller).
        if (Reflect.getMetadata(METHOD_METADATA, methodRef) === undefined) continue;

        // `getAllAndOverride([methodRef, ControllerClass])` is what the guard,
        // the boot audits and the route manifest all use — Nest does NOT copy
        // class-level decorators onto method refs, so reading the method alone
        // would under-report every class-level `@ForbidApiKey()`.
        const targets = [methodRef as never, ControllerClass] as const;
        const apiKeyScopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [...targets]);
        const svcScopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [...targets]);

        const facts: RouteAuthorizationFacts = {
          isPublic:
            reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [...targets]) === true ||
            reflector.getAllAndOverride<boolean>('isPublic', [...targets]) === true,
          apiKeyForbidden: reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [...targets]) === true,
          apiKeyScopes: Array.isArray(apiKeyScopes) ? apiKeyScopes : [],
          forbidServiceAccount: reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [...targets]) === true,
          svcScopes: Array.isArray(svcScopes) ? svcScopes : [],
        };

        // A controller instantiated in two modules is walked twice; same route,
        // same metadata, so first write wins and the second is a no-op.
        byOperationId.set(`${ControllerClass.name}_${handler}`, securityForRoute(facts));
      }
    }
  }

  return byOperationId;
}

export interface ApplyOperationSecurityResult {
  /** Operations whose `security` was set from the authorization metadata. */
  credentialed: number;
  /** Public operations, from which `security` was removed. */
  publicOperations: number;
}

/**
 * Overwrite every operation's `security` in place from the authorization
 * metadata. Called by BOTH consumers of `buildSwaggerConfig()` — the committed
 * `openapi.json` and the dev-only Swagger UI — so the two cannot disagree.
 *
 * THROWS on an operation it cannot join. The join key is Nest's default
 * `operationId`; a custom `@ApiOperation({ operationId })` or a custom
 * `operationIdFactory` would break it, and publishing a silently un-updated
 * (i.e. duplicated-bearer, api-key-less) security block for such an operation is
 * exactly the failure this module exists to end. Fail the emit instead.
 */
export function applyOperationSecurity(document: OpenAPIObject, app: INestApplicationContext): ApplyOperationSecurityResult {
  const byOperationId = collectRouteSecurity(app);
  const result: ApplyOperationSecurityResult = { credentialed: 0, publicOperations: 0 };
  const unmatched: string[] = [];

  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method)) continue;
      const op = operation as { operationId?: string; security?: SecurityRequirement[] };

      const operationId = op.operationId;
      if (!operationId || !byOperationId.has(operationId)) {
        unmatched.push(`${method.toUpperCase()} ${path} (operationId: ${operationId ?? 'none'})`);
        continue;
      }

      const security = byOperationId.get(operationId);
      if (security) {
        op.security = security;
        result.credentialed += 1;
      } else {
        delete op.security;
        result.publicOperations += 1;
      }
    }
  }

  if (unmatched.length > 0) {
    throw new Error(
      `[operation-security] ${unmatched.length} operation(s) could not be joined to a route by operationId, so their ` +
        `security could not be derived. The join key is Nest's default \`<Controller>_<handler>\`; a custom operationId ` +
        `breaks it. Offending operations:\n  ${unmatched.join('\n  ')}`,
    );
  }

  return result;
}
