/**
 * TASK-403 — link-out URL for the dev-only Prisma Studio shell.
 *
 * The API serves the shell at `GET <apiBase>/admin/pstudio` (TASK-307/336).
 * Per TASK-336 OB-11 the bearer travels in the URL **fragment** (`#token=…`):
 * fragments are never sent to the server, and the shell scrubs the token from
 * history immediately after reading it.
 */
export function buildStudioShellUrl(apiBaseUrl: string, token: string): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  return `${base}/admin/pstudio#token=${encodeURIComponent(token)}`;
}
