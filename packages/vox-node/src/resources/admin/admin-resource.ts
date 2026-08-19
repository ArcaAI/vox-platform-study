/**
 * TASK-773 Phase D2 — the hand-authored base every `/api/v1/admin/**` resource
 * is generated on top of (§3.2: "Generated: `src/resources/admin/*.ts` …
 * Hand-authored, once: the `AdminResource` base (pagination iterator, If-Match
 * plumbing, error mapping)").
 *
 * Everything here exists because the admin plane has three contracts the three
 * pre-existing resources (`summarization`, `consultations`, `jobs`) never had
 * to face at scale, and which a generator must not be asked to re-derive per
 * route:
 *
 *   1. **Offset pagination** — 19 admin controllers return the house
 *      `PaginatedResponse` (`packages/applications/src/common/dto/paginated.response.ts`).
 *   2. **Optimistic concurrency** — 37 admin controllers carry
 *      `@RequiresIfMatch()` + `@ExpectedVersion()`: 428 on a missing header,
 *      412 on a stale one.
 *   3. **`svc:admin:*` scope gating** — the admin plane is deny-by-default for
 *      the machine credential class, so "which scope does this route need?"
 *      is the question an integrator asks most often, and almost always at
 *      the moment they are staring at a 403.
 *
 * Deliberately NOT here: the credential itself. A service-account token is
 * transport-level config (`core/service-account-token.ts` + `HopeClient`), and
 * an `AdminResource` is constructed from a `Transport` exactly like every
 * other resource in this package — it neither knows nor cares which of the
 * three credential classes is on the wire.
 */

import { PermissionError } from '../../core/errors';
import type { Transport, TransportRequestOptions } from '../../core/transport';
import type { QueryValue } from '../../core/url';

/**
 * The gateway's offset-pagination page, verbatim.
 *
 * Source of truth: `Paginated<T>` in
 * `packages/applications/src/common/dto/paginated.response.ts` — every
 * `Paginated<Xxx>Response` DTO on the admin plane extends it and only narrows
 * `data`. Four fields, and two of them mean something slightly different from
 * what their names suggest:
 *
 * - `count` is the TOTAL number of matching rows, not the number in `data`.
 *   It comes from a SEPARATE `repository.count(...)` query issued alongside
 *   the page query (see e.g. `TenantService.fetchAll`), so it is a consistent
 *   total only to the extent those two reads see the same snapshot.
 * - `page` is **0-based** (`PaginatedQuery.page` is `@Min(0)`, default `0`).
 *
 * @see {@link AdminResource.listAll} for why this type's `page`/`limit` are
 * NOT trustworthy inputs to a page-walking loop.
 */
export interface PaginatedPage<T> {
  /** TOTAL matching rows across all pages — not `data.length`. */
  count: number;
  /** Rows per page, echoed from the request (see {@link AdminResource.listAll}). */
  limit: number;
  /** 0-based page index, echoed from the request (see {@link AdminResource.listAll}). */
  page: number;
  data: T[];
}

/**
 * The house list query — one field per property of `PaginatedQuery`
 * (`packages/applications/src/common/dto/paginated.query.ts`), which every
 * paginated admin route accepts via `@Query()`.
 *
 * `search`/`searchFields`/`filters`/`sort` are the gateway's own stringly-typed
 * CSV mini-grammars, deserialized by
 * `packages/applications/src/common/paginatedQueryParamConverters.ts`
 * (`field[op]:value` filters, `name:asc` sorts). They are passed through
 * UNTOUCHED rather than modelled: the grammar is per-route (valid fields
 * depend on the target Prisma model) and the gateway 400s precisely on a
 * malformed token, so re-encoding it here would only add a second place to
 * get it wrong.
 *
 * The index signature carries the per-route extras many admin controllers
 * declare alongside `PaginatedQuery` (`tenantId`, `includeDisabled`,
 * `doctorId`, …).
 */
export interface AdminListQuery {
  /** 0-based. Default `0`. */
  page?: number;
  /** Rows per page. Gateway default `10`; the console offers 10/20/50. */
  limit?: number;
  search?: string;
  /** Comma-separated field names, e.g. `'name,phoneNumber'`. */
  searchFields?: string;
  /** `;`-separated `field[op]:value` tokens. */
  filters?: string;
  /** Comma-separated `field:asc|desc` tokens. */
  sort?: string;
  [param: string]: QueryValue;
}

/** Per-call options shared by every method on an {@link AdminResource}. */
export interface AdminRequestOptions {
  signal?: AbortSignal;
  /** Overrides the client-level request timeout for this call. */
  timeoutMs?: number;
}

/** Per-call options for {@link AdminResource.listPage} / {@link AdminResource.listAll}. */
export interface AdminListOptions extends AdminRequestOptions {
  query?: AdminListQuery;
}

/** A request spec for {@link AdminResource.request} — a route with NO optimistic-concurrency precondition. */
export interface AdminRequestSpec extends AdminRequestOptions {
  /** Default `'GET'`. */
  method?: string;
  /** Gateway-relative path WITHOUT the `api/v1` prefix, e.g. `'admin/tenants/abc'`. Interpolated ids must be `encodePathSegment`-ed by the caller. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * The scope(s) THIS route accepts, when they are not simply the resource's
   * {@link AdminResource.svcScope}. Set by generated code on the read routes
   * that also accept their area's `:read` sibling; defaults to the area scope
   * everywhere else. Only ever used to word a 403 — the gateway, not the SDK,
   * decides reachability.
   */
  svcScopes?: readonly string[];
}

/**
 * A request spec for {@link AdminResource.requestWithPrecondition} — a route
 * carrying `@RequiresIfMatch()`. `ifMatch` is REQUIRED by the type: on those
 * 37 controllers a write without it is a guaranteed 428, so it is a compile
 * error here rather than a runtime one.
 */
export interface AdminPreconditionedRequestSpec extends AdminRequestSpec {
  /** Default `'PATCH'` — the verb the gateway's OCC routes use. */
  method?: string;
  /** The row's expected `_version`. See {@link IfMatchPrecondition}. */
  ifMatch: IfMatchPrecondition;
}

/**
 * Anything that identifies the version a conditional write expects:
 *
 * - a **row previously read through this SDK** (`{ version }`) — the ergonomic
 *   path, and the reason no ETag ever has to be copied by hand;
 * - a bare **version number**;
 * - a raw **ETag string**, quoted (`'"7"'`) or bare (`'7'`), for a caller who
 *   lifted one out of a `Response` header.
 */
export type IfMatchPrecondition = string | number | { version: number };

/**
 * Rows per page when the caller names none. Matches the gateway's own
 * `DEFAULT_PAGE_SIZE` (`paginatedQueryParamConverters.ts`) so an SDK walk and
 * a console walk page identically.
 */
export const DEFAULT_ADMIN_PAGE_SIZE = 10;

/** RFC 7232 §2.3 strong validator: exactly `"<digits>"`, no `W/`, no `*`, no padding. Mirrors `STRONG_VALIDATOR_RE` in `apps/api/src/decorators/expectedVersion.decorator.ts`. */
const STRONG_VALIDATOR_RE = /^"(0|[1-9][0-9]*)"$/;
const BARE_VERSION_RE = /^(0|[1-9][0-9]*)$/;

function isVersionNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Render an {@link IfMatchPrecondition} as an `If-Match` header value.
 *
 * The gateway parses `If-Match` with a strict strong-validator regex and
 * **400s** on a weak validator (`W/"7"`), a wildcard (`*`), an unquoted body,
 * or a negative/non-integer version — see `extractExpectedVersion` in
 * `apps/api/src/decorators/expectedVersion.decorator.ts`. Every one of those
 * is a programming error, not a server condition, so this function throws a
 * `TypeError` locally rather than letting a caller discover it as a 400 from
 * production. (Same reasoning as rejecting two credential classes at client
 * construction: turn a guaranteed runtime refusal into a compile-time-adjacent
 * failure.)
 *
 * Version `0` is accepted on purpose: the gateway treats `"0"` as the
 * config-plane FIRST_EDIT_ETAG create-intent precondition, and each service's
 * compare-and-set decides create-vs-412 from there.
 */
export function toIfMatchHeader(precondition: IfMatchPrecondition): string {
  if (typeof precondition === 'number') {
    if (!isVersionNumber(precondition)) {
      throw new TypeError(`Invalid If-Match version ${precondition}: expected a non-negative integer (the row's \`version\` / \`_version\`).`);
    }
    return `"${precondition}"`;
  }

  if (typeof precondition === 'string') {
    if (STRONG_VALIDATOR_RE.test(precondition)) return precondition;
    if (BARE_VERSION_RE.test(precondition)) return `"${precondition}"`;
    throw new TypeError(
      `Invalid If-Match value ${JSON.stringify(precondition)}: the gateway requires an RFC 7232 strong validator of the form "<non-negative integer>" ` +
        '(no W/ weak prefix, no * wildcard) and rejects anything else with 400.',
    );
  }

  const version = precondition?.version;
  if (typeof version !== 'number' || !isVersionNumber(version)) {
    throw new TypeError(
      'Invalid If-Match source: the object must carry a non-negative integer `version` (as every versioned HOPE response DTO does).',
    );
  }
  return `"${version}"`;
}

function normalizePageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ADMIN_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`Invalid page size ${limit}: the gateway's PaginatedQuery declares @IsInt() @Min(1) and 400s on anything else.`);
  }
  return limit;
}

function normalizePageIndex(page: number | undefined): number {
  if (page === undefined) return 0;
  if (!Number.isInteger(page) || page < 0) {
    throw new TypeError(`Invalid page index ${page}: the gateway's PaginatedQuery declares @IsInt() @Min(0) and pages are 0-based.`);
  }
  return page;
}

/**
 * Base class for every `hope.admin.<area>` resource.
 *
 * ## Errors an integrator will actually hit
 *
 * **403 — you are missing a scope, not a privilege.** The admin plane is
 * deny-by-default for service accounts: a route serves a machine caller only
 * if it declares a `svc:admin:*` scope AND the presented token holds it. That
 * makes "which scope?" the first question of nearly every 403, so this base
 * appends the scope(s) the ROUTE accepts to the message of any
 * `PermissionError` it sees — {@link svcScope} for most routes, and the wider
 * set on a read route that also accepts its area's `:read` sibling, since
 * naming only the `:write` scope there would send a read-only integrator to
 * request more privilege than the route actually wants. The error CLASS is
 * unchanged — `catch (e) { if (e instanceof PermissionError) }` still works,
 * and `status`/`code`/`requestId` are preserved.
 *
 * **404 — may mean "not yours", not "does not exist".** HOPE's tenancy posture
 * is 404-over-403 (`.claude/rules/05-nestjs-api.md`): a cross-tenant read or
 * write returns 404 so that resource EXISTENCE is not leaked to a caller who
 * may not see it. For a service account this bites in a specific way — the
 * token's `workingTenantId` is bound at EXCHANGE time, not per request, so a
 * correct id read with a token bound to the wrong tenant is a 404 with nothing
 * wrong at the call site. `NotFoundError` carries that explanation in its own
 * message and this base deliberately does not add to it: the scope is not the
 * problem on a 404, and saying so would send the reader down the wrong path.
 *
 * **428 / 412 — the two halves of the OCC contract.** 428 means the route
 * required `If-Match` and got none; 412 means the version was stale and
 * `VersionConflictError.currentVersion` carries the server's current value.
 * Use {@link requestWithPrecondition} (whose `ifMatch` is required by the
 * type) and 428 becomes unreachable by construction.
 */
export abstract class AdminResource {
  /**
   * The `svc:admin:*` scope that reaches EVERY route on this resource — the
   * `svc:` twin of the `admin:*` scope the controller carried before TASK-757
   * (`toServiceAccountScope`). Generated subclasses declare it from the route
   * manifest, so the required scope is readable at the call site and quotable
   * in a 403.
   *
   * It is the resource's FLOOR, not a complete answer: since TASK-773 decision
   * O-3 an individual read route may accept its area's `:read` sibling as well,
   * which the generated method passes per call ({@link AdminRequestSpec.svcScopes})
   * so its 403 names what that route actually wants. A token holding only this
   * scope always reaches everything here; a token holding only the `:read`
   * sibling reaches the read routes.
   */
  abstract readonly svcScope: string;

  constructor(protected readonly transport: Transport) {}

  /**
   * Re-throw with the required scope(s) named, for a 403 only.
   *
   * Rebuilt rather than mutated: `Error.message` is writable, but reassigning
   * it on an error someone else constructed is the kind of spooky action that
   * makes a stack trace lie. The original is kept as `cause`.
   *
   * `scopes` is what THIS route accepts and is plural because the gateway
   * matches with OR (`enforceServiceAccountScopes` is `required.some(...)`), so
   * holding any one of them is enough. It defaults to the resource's own
   * {@link svcScope}, which is the case for all but the read routes widened by
   * TASK-773 decision O-3.
   */
  private explain(error: unknown, scopes: readonly string[]): unknown {
    if (!(error instanceof PermissionError) || scopes.some((scope) => error.message.includes(scope))) return error;
    const requirement =
      scopes.length === 1
        ? `the service-account scope \`${scopes[0]}\``
        : `ANY ONE of the service-account scopes ${scopes.map((scope) => `\`${scope}\``).join(', ')}`;
    return new PermissionError({
      message: `${error.message} (This route requires ${requirement}; a token that does not hold it authenticates fine and is then refused here.)`,
      code: error.code,
      requestId: error.requestId,
      headers: error.headers,
      cause: error,
    });
  }

  /** Issue one request through the shared transport, augmenting a 403 with the route's accepted scope(s). */
  private async send<T>(options: TransportRequestOptions, svcScopes?: readonly string[]): Promise<T> {
    try {
      return await this.transport.request<T>(options);
    } catch (error) {
      throw this.explain(error, svcScopes && svcScopes.length > 0 ? svcScopes : [this.svcScope]);
    }
  }

  /**
   * A route with no optimistic-concurrency precondition — reads, creates, and
   * the ~33 admin controllers that carry no `@RequiresIfMatch()`.
   *
   * Calling this on a route that DOES require a precondition yields a
   * `PreconditionRequiredError` (428). That is the intended failure: it is
   * loud, it is specific, and {@link requestWithPrecondition} exists so the
   * type system prevents it in generated code.
   */
  protected request<T>(spec: AdminRequestSpec): Promise<T> {
    return this.send<T>(
      {
        method: spec.method,
        path: spec.path,
        query: spec.query,
        body: spec.body,
        signal: spec.signal,
        timeoutMs: spec.timeoutMs,
      },
      spec.svcScopes,
    );
  }

  /**
   * A conditional write against one of the 37 `@RequiresIfMatch()` admin
   * controllers. `spec.ifMatch` is required by the type, so the 428 branch is
   * unreachable from generated code.
   *
   * The ergonomic path is to hand back the row you just read:
   *
   * ```ts
   * const tenant = await hope.admin.tenants.get(id);
   * await hope.admin.tenants.update(id, { name: 'New' }, { ifMatch: tenant });
   * ```
   *
   * This works because the gateway's `ETagInterceptor` derives the ETag from
   * the response body's own top-level `version` field (`ETag: "<version>"`),
   * so the row IS the precondition — there is no header to capture. That also
   * covers the case the interceptor deliberately skips: it emits no `ETag` at
   * all for collection responses (`{ data: [...] }`), so an item taken from a
   * {@link listPage}/{@link listAll} walk could never be written back from a
   * header, only from its own `version`.
   *
   * On drift the gateway answers 412 and `VersionConflictError.currentVersion`
   * carries the server's value: re-read, merge, retry. This SDK does NOT retry
   * automatically — a conflict means someone else's write needs merging, and
   * blind re-submission is how that write gets silently discarded.
   *
   * `async` (rather than returning `this.send(...)` directly) so an invalid
   * `ifMatch` REJECTS the returned promise instead of throwing synchronously
   * out of the call — a `Promise`-returning method that sometimes throws
   * before it returns forces every caller to write both `try/catch` and
   * `.catch()`. Same reasoning applies to {@link listPage}.
   */
  protected async requestWithPrecondition<T>(spec: AdminPreconditionedRequestSpec): Promise<T> {
    return this.send<T>(
      {
        method: spec.method ?? 'PATCH',
        path: spec.path,
        query: spec.query,
        body: spec.body,
        headers: { 'If-Match': toIfMatchHeader(spec.ifMatch) },
        signal: spec.signal,
        timeoutMs: spec.timeoutMs,
      },
      spec.svcScopes,
    );
  }

  /**
   * Fetch ONE page of a paginated admin list and return it unchanged.
   *
   * `page` and `limit` are always sent explicitly, even when the caller names
   * neither — see {@link listAll} for why that matters. An out-of-range
   * `page`/`limit` rejects rather than throwing synchronously (see
   * {@link requestWithPrecondition}).
   */
  protected async listPage<T>(path: string, options: AdminListOptions = {}, svcScopes?: readonly string[]): Promise<PaginatedPage<T>> {
    const query = { ...options.query };
    return this.send<PaginatedPage<T>>(
      {
        path,
        query: { ...query, page: normalizePageIndex(query.page), limit: normalizePageSize(query.limit) },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      svcScopes,
    );
  }

  /**
   * Walk every page of a paginated admin list, yielding rows.
   *
   * ```ts
   * for await (const tenant of hope.admin.tenants.listAll()) { … }
   * ```
   *
   * ### The trap this avoids
   *
   * The obvious implementation — read `page`/`limit` off each response and
   * increment — is WRONG against this gateway. The services echo the RAW query
   * values into the response (`const { limit, page } = props;` in
   * `TenantService.fetchAll` and its ~19 siblings), while the DEFAULTS are
   * applied separately, inside `withFormattedPaginatedProps`, only to the
   * database query. A request that omits `page`/`limit` therefore comes back
   * with `page: undefined, limit: undefined` over a page that really was
   * limited to 10 — and at least one non-list route returns `limit: 0`
   * outright (`TenantService`'s bulk config update). A loop that trusted those
   * fields would stall, skip, or divide by zero.
   *
   * So pagination is driven entirely from the REQUEST side: this iterator
   * always sends an explicit `page` and `limit`, and only ever reads `data`
   * and `count` back.
   *
   * ### Termination
   *
   * Two independent stop conditions, neither of which costs a wasted round trip:
   *
   * - a page shorter than the requested `limit` is the last page (including
   *   the empty first page of an empty collection);
   * - `count` rows have been yielded — this is what stops an exact-multiple
   *   collection (20 rows at 10/page) after 2 requests rather than 3.
   *
   * `count` is only ever used to stop EARLY, never to keep going: it comes
   * from a separate count query and can disagree with reality under concurrent
   * writes, so the short-page rule remains the authoritative terminator.
   *
   * ### Errors and early exit
   *
   * A failure on page N propagates out of the `for await` after page N-1's
   * rows have been yielded — the walk never ends quietly on an error, because
   * "the list ended" and "the list broke" must not look alike to a caller
   * iterating an admin surface. Breaking out of the loop stops the walk
   * immediately; no page is fetched speculatively.
   */
  protected async *listAll<T>(path: string, options: AdminListOptions = {}, svcScopes?: readonly string[]): AsyncGenerator<T, void, undefined> {
    const query = { ...options.query };
    const limit = normalizePageSize(query.limit);
    let page = normalizePageIndex(query.page);
    let yielded = 0;

    for (;;) {
      const result = await this.listPage<T>(path, { ...options, query: { ...query, page, limit } }, svcScopes);
      const rows = result?.data ?? [];
      for (const row of rows) yield row;
      yielded += rows.length;

      if (rows.length < limit) return;
      if (typeof result.count === 'number' && Number.isFinite(result.count) && yielded >= result.count) return;
      page += 1;
    }
  }
}
