import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_BASE_URL, getApiBaseUrl } from '../api-config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getApiBaseUrl', () => {
  it('uses VITE_API_URL when provided', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test/api/v1');
    expect(getApiBaseUrl()).toBe('https://api.example.test/api/v1');
  });

  it('falls back to the versioned backend URL when VITE_API_URL is unset/empty', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(getApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
  });

  // Regression: the default used to be the relative, version-less '/api', which
  // made login POST to the dev origin (http://localhost:5174/api/auth/login)
  // and miss the gateway's `api/v1` prefix.
  it('defaults to an absolute URL carrying the api/v1 prefix (not "/api")', () => {
    vi.stubEnv('VITE_API_URL', '');
    const url = getApiBaseUrl();
    expect(url).not.toBe('/api');
    expect(url).toMatch(/^https?:\/\//);
    expect(url.endsWith('/api/v1')).toBe(true);
  });
});
