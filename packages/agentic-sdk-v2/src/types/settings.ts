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
