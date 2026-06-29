import { BadRequestException } from '@nestjs/common';

/**
 * TASK-372 D8 (supporting backend change) — single source of truth for the
 * user-settings namespaces the platform recognises.
 *
 * Historically each consumer hard-coded its own namespace literal
 * (`arcaai-sdk` in UserPreferencesService, `arcaai-admin` for admin overrides).
 * The shared `VirtualizedDataGrid` persists per-user layout under
 * `ui.data-grid`, so this registry collects the known namespaces in one place
 * and is exported for controllers/services to reference instead of duplicating
 * the strings.
 *
 * NOTE: the settings endpoints intentionally remain OPEN to arbitrary
 * namespaces (the SDK `useUserSettings` hook lets a client choose its own), so
 * this is a *recognition* registry — not a rejecting allow-list. A strict
 * allow-list would be a breaking change for existing clients and is out of
 * scope here (see TASK-373 §5).
 */
export const USER_SETTINGS_NAMESPACES = {
  /** Consultation SDK preferences (selected pipeline, local config, …). */
  SDK: 'arcaai-sdk',
  /** Admin-applied per-user overrides (e.g. assigned-pipeline). */
  ADMIN: 'arcaai-admin',
  /** TASK-372 — per-user data-grid layout (column order/size/visibility/pinning/density). */
  UI_DATA_GRID: 'ui.data-grid',
} as const;

export type UserSettingsNamespace = (typeof USER_SETTINGS_NAMESPACES)[keyof typeof USER_SETTINGS_NAMESPACES];

/** The set of namespaces the platform explicitly recognises. */
export const KNOWN_USER_SETTINGS_NAMESPACES: ReadonlySet<string> = new Set(Object.values(USER_SETTINGS_NAMESPACES));

/** True when `namespace` is one the platform explicitly recognises. */
export function isKnownUserSettingsNamespace(namespace: string): boolean {
  return KNOWN_USER_SETTINGS_NAMESPACES.has(namespace);
}

/**
 * TASK-372 D8 — upper bound (bytes) for a single `ui.data-grid` setting value.
 * A grid layout is a small JSON blob; this guard keeps a malformed/abusive
 * client from persisting an unbounded string into a settings row.
 */
export const UI_DATA_GRID_MAX_BYTES = 16_384;

/**
 * TASK-375 (item 1 backend) — canonical validator for a `ui.data-grid` setting
 * value, shared by the self-service controller AND the service layer so EVERY
 * write path (self-service `PATCH /user/me/settings/...` and admin
 * `PATCH /admin/users/:id/settings/...`) enforces the same guard. The value is
 * the VirtualizedDataGrid layout: it must be well-formed JSON within
 * {@link UI_DATA_GRID_MAX_BYTES}. Throws `BadRequestException` (HTTP 400) on
 * violation. The size check runs first so a malicious oversized payload is
 * rejected before the (potentially expensive) JSON.parse.
 */
export function validateUiDataGridValue(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > UI_DATA_GRID_MAX_BYTES) {
    throw new BadRequestException(`Setting value exceeds the ${UI_DATA_GRID_MAX_BYTES}-byte limit for 'ui.data-grid'`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new BadRequestException(`Setting value for 'ui.data-grid' must be valid JSON`);
  }
}
