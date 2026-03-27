import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { tryRefreshToken } from '@/lib/auth-refresh';

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

  return headers;
}

function getBaseUrl(): string {
  return usePlaygroundStore.getState().apiBaseUrl;
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

export const adminClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
  deleteWithBody: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('DELETE', path, body, options),
  upload: <T>(path: string, formData: FormData, options?: RequestOptions) => requestMultipart<T>('POST', path, formData, options),
};
