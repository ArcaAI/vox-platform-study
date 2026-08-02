/**
 * Doctor (clinician) catalog fetch (TASK-599 Phase E).
 *
 * The SummaryCard lets a v1-migrating developer pick WHOSE DNA writing-style
 * the gateway applies to the generated summary. The chosen user id is forwarded
 * as `doctorId`; when none is selected NO `doctorId` is sent (department +
 * visit-type only). This mirrors `departments.ts` exactly — same `x-api-key`
 * auth parity, same trailing-slash tolerance, same reject-on-non-OK contract so
 * the caller can fall back to a free-text input.
 *
 * The global prefix is `api/v1`, so the URL is `{apiEndpoint}/api/v1/admin/users`.
 * The controller (`apps/api/.../user.controller.ts#fetchAll`) returns a PAGINATED
 * envelope (`{ count, limit, page, data: UserResponse[] }`), but we extract rows
 * DEFENSIVELY — accepting a bare array or any of `data`/`items`/`results` — so a
 * shape change does not silently break the picker.
 *
 * On the default listing each `UserResponse` carries `id`, `username`, and
 * `isServiceAccount`; the RBAC role assignments are opt-in (`includeRoles=true`)
 * and are platform roles (e.g. GLOBAL_ADMIN), NOT a clinical "DOCTOR"
 * designation. There is therefore no clinical-role field to filter on, so we
 * list every human user and only drop service accounts (never a hard fail if
 * that field is absent).
 */

/** One selectable doctor. `id` is submitted as `doctorId`. */
export interface DoctorOption {
  id: string;
  /** Human label shown in the select — the username / display name. */
  label: string;
}

/** A single row as returned by `GET /api/v1/admin/users` (subset we read). */
interface RawUser {
  id?: unknown;
  username?: unknown;
  isServiceAccount?: unknown;
}

/** Pull the row array out of either a bare array or a paginated envelope. */
function extractRows(body: unknown): RawUser[] {
  if (Array.isArray(body)) return body as RawUser[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'items', 'results'] as const) {
      const candidate = (body as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as RawUser[];
    }
  }
  return [];
}

function toOption(row: RawUser): DoctorOption | null {
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
  const username = typeof row.username === 'string' && row.username.trim() ? row.username.trim() : undefined;
  // Drop service accounts — they are never clinicians. Absent field ⇒ keep.
  if (row.isServiceAccount === true) return null;
  if (!id) return null;
  return { id, label: username ?? id };
}

/**
 * Fetch the tenant's users (clinicians). Rejects on any non-OK status or
 * network error so the caller can fall back to a free-text doctor input.
 * Trailing slashes on `apiEndpoint` are tolerated.
 */
export async function fetchDoctors(apiEndpoint: string, apiKey: string): Promise<DoctorOption[]> {
  const origin = apiEndpoint.trim().replace(/\/+$/, '');
  const res = await fetch(`${origin}/api/v1/admin/users`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Doctors fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return extractRows(body)
    .map(toOption)
    .filter((o): o is DoctorOption => o !== null);
}
