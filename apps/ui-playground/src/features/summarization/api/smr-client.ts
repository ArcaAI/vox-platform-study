import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { tryRefreshToken } from '@/lib/auth-refresh';

export class SmrApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'SmrApiError';
  }
}

function getEffectiveToken(): string {
  const { accessToken, isImpersonating, impersonationToken } =
    useAuthStore.getState();
  return isImpersonating && impersonationToken ? impersonationToken : accessToken;
}

function getHeaders(): HeadersInit {
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

  if (tenantId) {
    headers['X-Tenant-Id'] = tenantId;
  }

  return headers;
}

function getBaseUrl(): string {
  return usePlaygroundStore.getState().apiBaseUrl;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { timeout?: number },
  isRetry = false,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeoutId = options?.timeout
    ? setTimeout(() => controller.abort(), options.timeout)
    : undefined;

  try {
    const init: RequestInit = {
      method,
      headers: getHeaders(),
      signal: controller.signal,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (fetchErr) {
      if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
        throw new SmrApiError('Request timed out', 408);
      }
      throw new SmrApiError(
        `Network error: Unable to reach ${url}. Is the API gateway running?`,
        0,
      );
    }

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
      const message =
        (errorBody as { message?: string })?.message ??
        `Request failed: ${method} ${path} (${res.status})`;
      throw new SmrApiError(message, res.status, errorBody);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestSSE(
  path: string,
  onChunk: (data: string) => void,
  onDone?: () => void,
  isRetry = false,
): Promise<void> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok || !res.body) {
    if (res.status === 401 && !isRetry) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        return requestSSE(path, onChunk, onDone, true);
      }
    }
    throw new SmrApiError('SSE connection failed', res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            onDone?.();
            return;
          }
          onChunk(data);
        }
      }
    }
  } finally {
    reader.releaseLock();
    onDone?.();
  }
}

async function requestPostSSE(
  path: string,
  body: unknown,
  callbacks: {
    onChunk: (data: string) => void;
    onDone?: () => void;
    onError?: (err: Error) => void;
  },
  options?: { signal?: AbortSignal },
): Promise<void> {
  const url = `${getBaseUrl()}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  } catch (fetchErr) {
    if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') return;
    const err = new SmrApiError(
      `Network error: Unable to reach ${url}. Is the API gateway running?`,
      0,
    );
    callbacks.onError?.(err);
    throw err;
  }

  if (!res.ok || !res.body) {
    const err = new SmrApiError(`SSE POST failed: ${res.status}`, res.status);
    callbacks.onError?.(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            callbacks.onDone?.();
            return;
          }
          callbacks.onChunk(data);
        }
      }
    }
  } finally {
    reader.releaseLock();
    callbacks.onDone?.();
  }
}

export const smrClient = {
  get: <T>(path: string) =>
    request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: { timeout?: number }) =>
    request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown) =>
    request<T>('PATCH', path, body),
  delete: <T>(path: string) =>
    request<T>('DELETE', path),
  sse: requestSSE,
  postSSE: requestPostSSE,
};
