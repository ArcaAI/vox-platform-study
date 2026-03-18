export const FEATURE_SCOPE_DEPTH: Record<string, number> = {
  audio: 2,
};

export function extractScopeFromUrl(pathname: string): string | null {
  if (!pathname) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const root = segments[0];
  const depth = FEATURE_SCOPE_DEPTH[root] ?? 1;
  return segments.slice(0, depth).join('/');
}

export function extractScopeFromPath(modulePath: string): string | null {
  const match = modulePath.match(/^\/src\/docs\/(.+)\/index\.ts$/);
  return match?.[1] ?? null;
}
