/**
 * Client-side HTTP core for the typed feature API layer. Every call goes to
 * the BFF catch-all proxy (/api/hope/<gateway-path> -> ${API_URL}/api/v1/...),
 * which owns tokens, X-Tenant-Id and the 401 refresh-retry — this module only
 * speaks the platform envelopes: `{ data, count }` pagination, the NestJS
 * error body, and the If-Match/ETag optimistic-concurrency contract.
 */

/** Offset-paginated list envelope (PaginatedResponse in @arcaai/applications). */
export interface Paginated<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

/** Keyset envelope used by deep scans (e.g. GET /admin/audit-logs/cursor). */
export interface CursorPaginated<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/** A read plus the ETag needed to PATCH the row later (If-Match). */
export interface WithEtag<T> {
  data: T;
  etag: string | null;
}

/** Gateway (NestJS) error body: `message` is a string or validation array. */
interface GatewayErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
}

export class GatewayError extends Error {
  readonly status: number;
  /** NestJS error name (e.g. "Bad Request") when the body carried one. */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * 404-over-403 tenancy posture: a cross-tenant access surfaces as 404.
   * Treat it as "not yours or gone", never as a missing route.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 412: the row changed since the read (ETag drift) — reload, reapply. */
  get isVersionConflict(): boolean {
    return this.status === 412;
  }

  /** 428: the mutation omitted If-Match on a versioned row (client bug). */
  get isMissingPrecondition(): boolean {
    return this.status === 428;
  }
}

async function toGatewayError(response: Response): Promise<GatewayError> {
  const fallback = `Request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as GatewayErrorBody;
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return new GatewayError(response.status, message || fallback, body.error);
  } catch {
    return new GatewayError(response.status, fallback);
  }
}

/**
 * Numeric row version carried by a strong ETag (`"7"` -> 7). Versioned PATCH
 * DTOs validate a required body `expectedVersion` in addition to the If-Match
 * header (the header overrides the body server-side), so clients derive the
 * number from the ETag they captured at read time.
 */
export function versionFromEtag(etag: string): number {
  const version = Number(etag.replaceAll('"', ''));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`ETag "${etag}" does not carry a row version`);
  }
  return version;
}

/** Query params: undefined/null entries are omitted from the string. */
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

const PROXY_MOUNT = '/api/hope/';

/** Proxied URL for a gateway path (relative to /api/v1, no leading slash). */
export function hopeUrl(path: string, params?: QueryParams): string {
  return `${PROXY_MOUNT}${path}${buildQuery(params)}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  params?: QueryParams;
  /** JSON-serialized when defined. */
  body?: unknown;
  /** Sent as If-Match — required by PATCH routes on versioned rows. */
  etag?: string;
  signal?: AbortSignal;
}

/**
 * Performs a proxied gateway request. Throws GatewayError on non-2xx; returns
 * the parsed JSON body plus the response ETag (null when absent).
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<WithEtag<T>> {
  const headers = new Headers();
  const isForm = options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers.set('content-type', 'application/json');
  if (options.etag) headers.set('if-match', options.etag);

  const response = await fetch(hopeUrl(path, options.params), {
    method: options.method ?? 'GET',
    headers,
    body: isForm ? (options.body as FormData) : options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    throw await toGatewayError(response);
  }

  const responseEtag = response.headers.get('etag');
  const etag = responseEtag && !responseEtag.startsWith('W/') ? responseEtag : null;
  if (response.status === 204) {
    return { data: undefined as T, etag };
  }
  const text = await response.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, etag };
}

/** GET returning only the body (lists, unversioned reads). */
export async function getJson<T>(path: string, params?: QueryParams): Promise<T> {
  return (await request<T>(path, { params })).data;
}

/** GET keeping the ETag — use for reads that back an If-Match PATCH. */
export async function getWithEtag<T>(path: string, params?: QueryParams): Promise<WithEtag<T>> {
  return request<T>(path, { params });
}

export async function postJson<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
  return (await request<T>(path, { method: 'POST', body, params })).data;
}

export async function putJson<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
  return (await request<T>(path, { method: 'PUT', body, params })).data;
}

/** PATCH of a versioned row: the caller passes the ETag captured at read time. */
export async function patchWithEtag<T>(path: string, body: unknown, etag: string): Promise<WithEtag<T>> {
  return request<T>(path, { method: 'PATCH', body, etag });
}

/** PUT of a versioned row (full-record OCC write): the caller passes the ETag captured at read time. */
export async function putWithEtag<T>(path: string, body: unknown, etag: string): Promise<WithEtag<T>> {
  return request<T>(path, { method: 'PUT', body, etag });
}

/** PATCH of an unversioned resource (no If-Match requirement). */
export async function patchJson<T>(path: string, body?: unknown): Promise<T> {
  return (await request<T>(path, { method: 'PATCH', body })).data;
}

/** DELETE; break-glass routes carry a step-up credentials body. */
export async function deleteJson<T = void>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
  return (await request<T>(path, { method: 'DELETE', body, params })).data;
}

/** GET of a file stream (audit/users export). Returns the Blob + filename hints. */
export async function getBlob(
  path: string,
  params?: QueryParams,
): Promise<{ blob: Blob; contentType: string | null; contentDisposition: string | null }> {
  const response = await fetch(hopeUrl(path, params), { method: 'GET' });
  if (!response.ok) {
    throw await toGatewayError(response);
  }
  return {
    blob: await response.blob(),
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
  };
}
