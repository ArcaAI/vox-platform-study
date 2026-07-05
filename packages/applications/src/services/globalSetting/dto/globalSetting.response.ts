import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ValueType } from '@arcaai/domains';

export class GlobalSettingResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the global setting' })
  name!: string;

  @ApiProperty({
    description: 'Description of the global setting',
    required: false,
  })
  description?: string;

  @ApiProperty({ description: 'Unique key for the global setting' })
  key!: string;

  @ApiProperty({ description: 'Value of the global setting' })
  value!: string;

  @ApiProperty({
    description: 'Data type of the global setting',
    enum: ValueType,
  })
  dataType!: ValueType;

  @ApiProperty({
    description: 'Namespace for the global setting',
    required: false,
  })
  namespace?: string;

  /**
   * TASK-332 / TASK-391 (D2) — platform-owned "locked" default. When true the
   * row is write-guarded server-side (only GLOBAL_ADMIN may modify it); the admin
   * console mirrors this by rendering a lock affordance and disabling edit/delete
   * for non-super-admins. Exposed so `GET /admin/settings` returns it (the FE
   * cannot render the guard otherwise).
   *
   * Required (its intended shape): the backing entity column is non-null
   * (`@default(false)`) and the mapper always populates it, so every response
   * carries a boolean. (TASK-391 D2 briefly declared this optional only to keep
   * the tenant controllers' `... as PaginatedTenantConfigResponse` superset cast
   * compiling; TASK-393 removed that cast via `TenantConfigDtoMapper`, so the
   * required shape is restored.)
   */
  @ApiProperty({
    description: 'Whether the setting is a locked, platform-owned default (super-admin-only write).',
    example: false,
  })
  locked!: boolean;

  /**
   * Optimistic-concurrency token — TASK-302 Stream D Phase C.
   *
   * Clients must echo this value back as `expectedVersion` on the
   * subsequent PATCH; the server's compare-and-set (`updateWithVersion`)
   * fails with 412 Precondition Failed if `_version` has drifted under us.
   *
   * Phase D adds an `ETag: "<version>"` response header so SDK clients
   * can use the canonical RFC 7232 `If-Match` mechanism instead of
   * threading the field through the body; both shapes remain supported.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;

  /**
   * TASK-396 — server-authoritative "this row holds a secret" marker. True when
   * the row has a Vault-encrypted `encryptedValue` OR its key/namespace matches
   * the secret naming convention (see `GlobalSettingDtoMapper`). When true the
   * mapper MASKS `value` (returns `''`) on list/get responses; the plaintext is
   * only ever returned by the gated, audited, super-admin-only reveal endpoint
   * (`POST /admin/settings/:id/reveal`). The admin console renders the masked
   * value with an enabled "Reveal" affordance for these rows.
   */
  @ApiProperty({
    description: 'Whether this setting stores a secret (value is masked in list/get; reveal via the dedicated endpoint).',
    example: false,
  })
  isSecret!: boolean;

  constructor(init: GlobalSettingResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.description = init.description;
    this.key = init.key;
    this.value = init.value;
    this.dataType = init.dataType;
    this.namespace = init.namespace;
    this.locked = init.locked;
    this.version = init.version;
    this.isSecret = init.isSecret ?? false;
  }
}
