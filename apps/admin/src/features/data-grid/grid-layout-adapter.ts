import type { GridLayoutPersistenceAdapter, GridLayoutState } from '@arcaai/ui/components/data-grid';

/**
 * Minimal slice of `useUserSettings` the adapter needs. Declaring it here (rather
 * than importing the SDK return type) keeps {@link createGridLayoutAdapter} a
 * pure function with no `@arcaai/vox` runtime dependency, so the D8 round-trip is
 * unit-testable with a plain fake (TASK-374).
 */
export interface GridSettingsClient {
  list: () => Promise<Array<{ namespace?: unknown; key: string; value: unknown }>>;
  updateByKey: (namespace: string, key: string, value: unknown) => Promise<unknown>;
}

/**
 * Pure factory for the server-persisted grid-layout adapter (TASK-372 D8).
 * Persists per-user column order/sizing/visibility/pinning/density under the
 * `ui.data-grid` user-settings namespace via `GET /user/me/settings` +
 * `PATCH /user/me/settings/:namespace/:key`.
 *
 * Best-effort by contract: `useGridLayout` swallows load/save rejections and
 * keeps in-memory defaults, so an un-whitelisted namespace never breaks a grid —
 * it just won't persist.
 */
export function createGridLayoutAdapter(settings: GridSettingsClient): GridLayoutPersistenceAdapter {
  return {
    async load(namespace, key) {
      const all = await settings.list();
      const match = all.find((s) => (s.namespace as string | undefined) === namespace && s.key === key);
      const value = match?.value;
      // The settings API persists `value` as a JSON string (server contract:
      // `UpdateUserSettingByKeyRequest.value` is `@IsString()`, validated via
      // `JSON.parse`). Parse it back to the layout; tolerate an already-parsed
      // object for forward-compat with any client that pre-parses.
      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          return parsed && typeof parsed === 'object' ? (parsed as GridLayoutState) : null;
        } catch {
          return null;
        }
      }
      return value && typeof value === 'object' ? (value as GridLayoutState) : null;
    },
    async save(namespace, key, state) {
      // Server contract: `value` is a JSON string (validated server-side via
      // `JSON.parse` within a byte cap), so serialize before persisting.
      await settings.updateByKey(namespace, key, JSON.stringify(state));
    },
  };
}
