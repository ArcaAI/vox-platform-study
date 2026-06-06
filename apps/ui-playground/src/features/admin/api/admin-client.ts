import { toast } from 'sonner';
import { tryRefreshToken } from '@/lib/auth-refresh';
import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';

export class AdminApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface RequestOptions {
  tenantId?: string;
  /**
   * RFC 7232 `If-Match` header carrying a strong validator (e.g. `"7"`).
   * Added in TASK-302 Stream D Phase D.5 so config-editor mutations can
   * satisfy `@RequiresIfMatch()` routes. Passing the wrong value yields
   * `412 Precondition Failed`; omitting it on a required route yields
   * `428 Precondition Required` — both surface to the caller as
   * `AdminApiError` with the appropriate `status`.
   */
  ifMatch?: string;
}

/**
 * Standard pagination envelope returned by the **admin** API plane
 * (`/admin/*`, `/tenant/me/config`). The admin endpoints report the total
 * matching-row count in `count` — deliberately distinct from the SDK's
 * consultation / transcription list shape and the audio-pipelines module,
 * which use `total`. Readers of an admin response MUST use `count`; readers
 * of an SDK / pipelines response MUST use `total`.
 *
 * TASK-323 D3 — a single shared definition (instead of one re-declared per
 * admin module) keeps the field name unambiguous and consistent across the
 * admin api layer. Non-behavioral: the wire shape is unchanged.
 */
export interface PaginatedResponse<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

function getEffectiveToken(): string {
  const { accessToken, isImpersonating, impersonationToken } = useAuthStore.getState();
  return isImpersonating && impersonationToken ? impersonationToken : accessToken;
}

function getHeaders(options?: RequestOptions): HeadersInit {
  const { apiKey, authMethod, tenantId } = useAuthStore.getState();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authMethod === 'credentials') {
    const token = getEffectiveToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } else if (authMethod === 'apiKey' && apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const effectiveTenant = options?.tenantId ?? tenantId;
  if (effectiveTenant) {
    headers['X-Tenant-Id'] = effectiveTenant;
  }

  if (options?.ifMatch) {
    headers['If-Match'] = options.ifMatch;
  }

  return headers;
}

function getBaseUrl(): string {
  return usePlaygroundStore.getState().apiBaseUrl;
}

/**
 * AC-09 (TASK-336): on a 401 the client drops any active impersonation and
 * retries as the admin. Previously this was silent, so the operator had no idea
 * their "acting as" session had ended and could keep working as themselves
 * believing they were still impersonating. End the session AND surface an
 * explicit, user-visible notice. No-op when not impersonating.
 */
function endImpersonationWithNotice(): void {
  const { isImpersonating, impersonatedUser } = useAuthStore.getState();
  if (!isImpersonating) return;
  useAuthStore.getState().endImpersonation();
  const who = impersonatedUser?.username ? ` as ${impersonatedUser.username}` : '';
  toast.warning('Impersonation ended', {
    description: `Your impersonation session${who} expired or was revoked. You are now acting as yourself.`,
  });
}

async function request<T>(method: string, path: string, body?: unknown, options?: RequestOptions, isRetry = false): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const init: RequestInit = {
    method,
    headers: getHeaders(options),
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    if (res.status === 401 && !isRetry) {
      endImpersonationWithNotice();
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        return request<T>(method, path, body, options, true);
      }
    }

    let errorBody: unknown;
    try {
      errorBody = await res.json();
    } catch {
      /* empty */
    }
    const message = (errorBody as { message?: string })?.message ?? `Request failed: ${method} ${path} (${res.status})`;
    throw new AdminApiError(message, res.status, errorBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Sends a multipart/form-data request (used for file uploads).
 * Callers pass a pre-built FormData — no Content-Type header is set
 * so the browser can generate the correct multipart boundary.
 */
async function requestMultipart<T>(method: string, path: string, formData: FormData, options?: RequestOptions, isRetry = false): Promise<T> {
  const { apiKey, authMethod, tenantId } = useAuthStore.getState();
  const headers: Record<string, string> = {};

  if (authMethod === 'credentials') {
    const token = getEffectiveToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } else if (authMethod === 'apiKey' && apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  const effectiveTenant = options?.tenantId ?? tenantId;
  if (effectiveTenant) {
    headers['X-Tenant-Id'] = effectiveTenant;
  }

  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, { method, headers, body: formData });

  if (!res.ok) {
    if (res.status === 401 && !isRetry) {
      endImpersonationWithNotice();
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        return requestMultipart<T>(method, path, formData, options, true);
      }
    }

    let errorBody: unknown;
    try {
      errorBody = await res.json();
    } catch {
      /* empty */
    }
    const message = (errorBody as { message?: string })?.message ?? `Request failed: ${method} ${path} (${res.status})`;
    throw new AdminApiError(message, res.status, errorBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function stream(path: string, signal?: AbortSignal, options?: RequestOptions): Promise<Response> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'GET',
    headers: getHeaders(options),
    signal,
  });

  if (!res.ok) {
    let errorBody: unknown;
    try {
      errorBody = await res.json();
    } catch {
      /* empty */
    }
    const message = (errorBody as { message?: string })?.message ?? `Request failed: GET ${path} (${res.status})`;
    throw new AdminApiError(message, res.status, errorBody);
  }

  return res;
}

export const adminClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
  deleteWithBody: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('DELETE', path, body, options),
  upload: <T>(path: string, formData: FormData, options?: RequestOptions) => requestMultipart<T>('POST', path, formData, options),
  stream,
};
