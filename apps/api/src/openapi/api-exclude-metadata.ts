/**
 * Readers for `@nestjs/swagger`'s two exclusion decorators.
 *
 * `@ApiExcludeController()` / `@ApiExcludeEndpoint()` mark a route as
 * deliberately ABSENT from `openapi.json`. Anything that cross-checks the
 * route manifest against the spec has to be able to tell those apart from a
 * route that is merely MISSING its Swagger decorators — the first is a
 * decision, the second is a documentation defect.
 *
 * ## Why this is a module and not two inline `=== true` checks
 *
 * Neither decorator stores a boolean. Both go through
 * `@nestjs/swagger`'s `decorators/helpers.ts`, which wraps the argument:
 *
 *   - `@ApiExcludeEndpoint()` -> `createMethodDecorator(key, { disable: true })`
 *                                  stores the OBJECT `{ disable: true }`.
 *   - `@ApiExcludeController()` -> `createClassDecorator(key, [true])`
 *                                  stores the ARRAY `[true]`.
 *
 * Reading either with `=== true` is therefore always false. `emit-route-manifest.ts`
 * did exactly that until, so every one of the 657 manifest rows
 * reported `apiExcluded: false` while 69 routes (every `*RedirectShimController`
 * and every `/internal/*` controller) were genuinely excluded. The cross-check
 * those flags exist to power could never fire in either direction.
 *
 * The two functions below mirror `@nestjs/swagger`'s OWN explorers
 * (`explorers/api-exclude-controller.explorer.ts`, `…-endpoint.explorer.ts`)
 * verbatim. That is deliberate: it is the only way the manifest and the spec
 * can agree by construction rather than by coincidence.
 *
 * The metadata KEYS are inlined string literals rather than imported from
 * `@nestjs/swagger/dist/constants`, whose subpath is not exported by that
 * package's `exports` map. `api-exclude-metadata.test.ts` applies the REAL
 * decorators and asserts these readers see them, so a key rename upstream
 * fails the test rather than silently reporting "nothing is excluded".
 */

/** `DECORATORS.API_EXCLUDE_ENDPOINT` in `@nestjs/swagger/dist/constants`. */
export const API_EXCLUDE_ENDPOINT_KEY = 'swagger/apiExcludeEndpoint';

/** `DECORATORS.API_EXCLUDE_CONTROLLER` in `@nestjs/swagger/dist/constants`. */
export const API_EXCLUDE_CONTROLLER_KEY = 'swagger/apiExcludeController';

/** Mirrors `exploreApiExcludeControllerMetadata`: the decorator stores `[true]`. */
export function isControllerApiExcluded(ControllerClass: object): boolean {
  const metadata: unknown = Reflect.getMetadata(API_EXCLUDE_CONTROLLER_KEY, ControllerClass);
  return Array.isArray(metadata) && metadata[0] === true;
}

/** Mirrors `exploreApiExcludeEndpointMetadata` + its consumer: the decorator stores `{ disable: true }`. */
export function isEndpointApiExcluded(methodRef: object): boolean {
  const metadata: unknown = Reflect.getMetadata(API_EXCLUDE_ENDPOINT_KEY, methodRef);
  return typeof metadata === 'object' && metadata !== null && (metadata as { disable?: unknown }).disable === true;
}
