/**
 * Fetches the SAME discovery bundle `@arcaai/vox` reads at session start
 * `GET /tenant/me/context-schema` — as a global-admin
 * "manage as tenant" call: `Authorization: Bearer <token>` for a
 * GLOBAL_ADMIN whose JWT carries an empty tenant binding, plus
 * `X-Tenant-Id: <tenantId>` to select the target tenant
 * (`resolve-active-tenant.ts`'s elevation path — the same mechanism the
 * admin-console BFF proxy uses for its "working tenant").
 *
 * Unlike the SDK's fetch (`ConsultationSchemaClient.ts`), which is
 * deliberately FAIL-OPEN — a live consultation session must never block on a
 * schema-plane outage — this is a build-time tool with no such urgency. A
 * fetch failure here throws `CodegenError` and stops the run; it never
 * silently falls back to "no schema configured" (that would emit a types
 * file claiming a tenant has no schema when the truth is just "the gateway
 * was unreachable").
*/

import { CodegenError } from './errors';
import type { ConsultationSchemaBundle } from './types';

export interface FetchConsultationSchemaOptions {
  /** Gateway origin, e.g. `http://localhost:8868`. May include a trailing `/api/v1` — normalized away. */
  baseUrl: string;
  tenantId: string;
  /** Bearer JWT for a GLOBAL_ADMIN user (see module doc). */
  token: string;
  /** Prefer the department-scoped default, falling back to the tenant default. */
  departmentId?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const API_PREFIX = '/api/v1';

function normalizeBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith(API_PREFIX)) {
    base = base.slice(0, -API_PREFIX.length);
  }
  return base;
}

function buildUrl(options: FetchConsultationSchemaOptions): string {
  const base = normalizeBaseUrl(options.baseUrl);
  const query = options.departmentId ? `?departmentId=${encodeURIComponent(options.departmentId)}` : '';
  return `${base}${API_PREFIX}/tenant/me/context-schema${query}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainDefinition(value: unknown): value is ConsultationSchemaBundle['definition'] {
  return value === null || value === undefined || isPlainObject(value);
}

function parseBundle(raw: unknown, url: string): ConsultationSchemaBundle {
  if (!isPlainObject(raw)) {
    throw new CodegenError(`GET ${url} returned a non-object response body`);
  }
  if (!isPlainDefinition(raw.definition)) {
    throw new CodegenError(`GET ${url} returned a malformed \`definition\` field`);
  }
  return {
    schemaId: typeof raw.schemaId === 'string' ? raw.schemaId : null,
    slug: typeof raw.slug === 'string' ? raw.slug : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    versionNumber: typeof raw.versionNumber === 'number' ? raw.versionNumber : null,
    contextSchemaVersionId: typeof raw.contextSchemaVersionId === 'string' ? raw.contextSchemaVersionId : null,
    checksum: typeof raw.checksum === 'string' ? raw.checksum : null,
    definition: (raw.definition ?? null) as ConsultationSchemaBundle['definition'],
    etag: typeof raw.etag === 'string' ? raw.etag : 'none',
  };
}

/** Fetch and parse the discovery bundle for one tenant. Throws {@link CodegenError} on any failure. */
export async function fetchConsultationSchemaBundle(options: FetchConsultationSchemaOptions): Promise<ConsultationSchemaBundle> {
  const url = buildUrl(options);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        'X-Tenant-Id': options.tenantId,
        Accept: 'application/json',
      },
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CodegenError(`Failed to reach ${url}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CodegenError(`GET ${url} returned ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CodegenError(`GET ${url} returned a body that could not be parsed as JSON: ${reason}`);
  }

  return parseBundle(raw, url);
}
