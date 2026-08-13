/**
 * Department catalog fetch (Workstream B,).
 *
 * The SummaryCard lets a v1-migrating developer pick a REAL tenant department
 * so the gateway's Workstream-A resolver can match it (by code, name, or v1
 * synonym) to a governed instruction template. We hit the admin listing route
 * directly with the same `x-api-key` the `<ArcaCompatProvider>` was configured
 * with — the SDK's `useSMR` uses the identical auth parity.
 *
 * The global prefix is `api/v1`, so the URL is
 * `{apiEndpoint}/api/v1/admin/departments`. The controller
 * (`apps/api/.../department.controller.ts#fetchAll`) returns a bare
 * `DepartmentResponse[]`, but we map DEFENSIVELY — accepting an array or any of
 * the common paginated envelopes (`data`/`items`/`results`) — so a future
 * change to a wrapped response shape does not silently break the picker.
*/

/** One selectable department. `value` is what we submit as `departmentId`. */
export interface DepartmentOption {
  id: string;
  /** Preferred submit value: department code when present, else the name. */
  value: string;
  /** Human label shown in the select. */
  label: string;
}

/** A single row as returned by `GET /api/v1/admin/departments` (subset we read). */
interface RawDepartment {
  id?: unknown;
  code?: unknown;
  name?: unknown;
}

/** Pull the row array out of either a bare array or a paginated envelope. */
function extractRows(body: unknown): RawDepartment[] {
  if (Array.isArray(body)) return body as RawDepartment[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'items', 'results'] as const) {
      const candidate = (body as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as RawDepartment[];
    }
  }
  return [];
}

function toOption(row: RawDepartment): DepartmentOption | null {
  const id = typeof row.id === 'string' ? row.id : undefined;
  const code = typeof row.code === 'string' && row.code.trim() ? row.code.trim() : undefined;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
  const value = code ?? name;
  if (!value) return null;
  return {
    id: id ?? value,
    value,
    // Show the name (falling back to the code); annotate the code so the
    // developer sees exactly what the resolver will match on.
    label: name ? (code ? `${name} (${code})` : name) : value,
  };
}

/**
 * Fetch the tenant's departments. Rejects on any non-OK status or network
 * error so the caller can fall back to a free-text department input. Trailing
 * slashes on `apiEndpoint` are tolerated.
 */
export async function fetchDepartments(apiEndpoint: string, apiKey: string): Promise<DepartmentOption[]> {
  const origin = apiEndpoint.trim().replace(/\/+$/, '');
  const res = await fetch(`${origin}/api/v1/admin/departments`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Departments fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return extractRows(body)
    .map(toOption)
    .filter((o): o is DepartmentOption => o !== null);
}
