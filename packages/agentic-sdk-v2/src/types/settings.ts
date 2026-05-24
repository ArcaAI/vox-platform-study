/**
 * @arcaai/vox - Settings Types (TASK-032 WS-A)
 *
 * Types for global settings and user settings.
 */

export interface GlobalSetting {
  id: string;
  key: string;
  name?: string;
  value: unknown;
  dataType?: string;
  namespace?: string;
  description?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface CreateGlobalSettingInput {
  key: string;
  name?: string;
  value: unknown;
  dataType?: string;
  namespace?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface UpdateGlobalSettingInput {
  value?: unknown;
  [key: string]: unknown;
}

export interface UserSetting {
  id: string;
  key: string;
  value: unknown;
  userId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface CreateUserSettingInput {
  key: string;
  name?: string;
  value: unknown;
  dataType?:
    | 'String'
    | 'Integer'
    | 'Float'
    | 'Double'
    | 'Decimal'
    | 'Boolean'
    | 'Json'
    | 'Date'
    | 'DateTime'
    | 'Array'
    | 'Uuid'
    | 'Binary'
    | 'Enum'
    | 'Hstore'
    | 'Inet'
    | 'Citext'
    | 'Interval';
  namespace?: string;
  userId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface UpdateUserSettingInput {
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Error thrown when a setting update fails the server's optimistic-concurrency
 * check — TASK-302 Stream D Phase D (D.4).
 *
 * The server returns `412 Precondition Failed` when the client's `If-Match`
 * header points to a stale row version. The SDK transforms that HTTP error
 * into this structured class so callers can:
 *
 *   try {
 *     await update(id, input);
 *   } catch (err) {
 *     if (err instanceof ConfigConflictError) {
 *       // show conflict modal, offer refresh-and-retry
 *     } else {
 *       throw err;
 *     }
 *   }
 *
 * Fields:
 *   - `settingId` — the row that conflicted (same as the GET id).
 *   - `expectedVersion` — what the client's cached ETag pointed to.
 *   - `currentVersion` — what the server has now (from the 412 response body).
 *
 * The cache is invalidated on throw so a follow-up `get(id)` is required
 * before retrying — this prevents the SDK from blindly re-applying a stale
 * value.
 */
export class ConfigConflictError extends Error {
  readonly code = 'CONFIG_CONFLICT';

  constructor(
    public readonly settingId: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Setting ${settingId} was changed by someone else ` +
        `(yourVersion=${expectedVersion}, currentVersion=${currentVersion}). ` +
        `Refresh and try again.`,
    );
    this.name = 'ConfigConflictError';
    // Required for `instanceof` to work across the transpilation boundary
    // in environments that emit ES5 prototype-chain code.
    Object.setPrototypeOf(this, ConfigConflictError.prototype);
  }
}
