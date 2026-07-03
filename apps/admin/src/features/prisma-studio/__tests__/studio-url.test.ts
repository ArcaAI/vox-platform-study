import { describe, expect, it } from 'vitest';
import { buildStudioShellUrl } from '../studio-url';

// TASK-403 — the Studio shell (dev-only, served by the API) reads the bearer
// from the URL fragment (`#token=…`, TASK-336 OB-11): the fragment is never
// sent to the server and the shell scrubs it from history on load.
describe('buildStudioShellUrl', () => {
  it('appends the pstudio shell path and the token fragment to the API base', () => {
    expect(buildStudioShellUrl('http://localhost:8868/api/v1', 'jwt-abc')).toBe('http://localhost:8868/api/v1/admin/pstudio#token=jwt-abc');
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildStudioShellUrl('http://localhost:8868/api/v1/', 'jwt-abc')).toBe('http://localhost:8868/api/v1/admin/pstudio#token=jwt-abc');
  });

  it('URL-encodes the token', () => {
    expect(buildStudioShellUrl('http://x/api/v1', 'a+b/c=')).toBe('http://x/api/v1/admin/pstudio#token=a%2Bb%2Fc%3D');
  });
});
