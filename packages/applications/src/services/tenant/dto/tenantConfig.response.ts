import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { EntityId, ValueType } from '@arcaai/domains';

/**
 * Constructor props for {@link TenantConfigResponse}.
 *
 * A dedicated props interface (mirroring `ApiKeyResponseProps`) so a
 * `TenantConfigResponse` can be built explicitly from a `GlobalSettingEntity`
 * (which surfaces `Date` timestamps) via {@link TenantConfigDtoMapper}. This
 * replaces the previous `init: TenantConfigResponse & BaseResponseProps`
 * constructor whose `string & Date` intersection on the base timestamp fields
 * blocked direct construction and pushed callers toward the fragile
 * `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse`
 * superset cast.
 */
export interface TenantConfigResponseProps extends BaseResponseProps {
  name: string;
  description?: string | null;
  key: string;
  defaultValue?: string | null;
  value: string;
  dataType: ValueType;
  namespace?: string | null;
  tenantId: EntityId;
  tenantCode?: string | null;
  locked?: boolean;
  version: number;
}

export class TenantConfigResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the configuration' })
  name!: string;

  @ApiProperty({ description: 'Description of the configuration', required: false })
  description?: string | null;

  @ApiProperty({ description: 'Unique key for the configuration' })
  key!: string;

  @ApiProperty({ description: 'Default value for the configuration', required: false })
  defaultValue?: string | null;

  @ApiProperty({ description: 'Value for the configuration' })
  value!: string;

  @ApiProperty({ description: 'Data type of the configuration value', enum: ValueType })
  dataType!: ValueType;

  @ApiProperty({ description: 'Namespace for the configuration', required: false })
  namespace?: string | null;

  @ApiProperty({ description: 'ID of the tenant this configuration belongs to' })
  tenantId!: EntityId;

  /**
   * Code/Key of the tenant this configuration belongs to.
   *
   * Optional: a tenant-config row is backed by a `GlobalSetting` entity, which
   * does not itself carry the tenant's code-name. The mapper therefore leaves it
   * unset; only the synthetic rows that already know the code (e.g. the
   * `enable-local-raw-capture` flag) populate it.
   */
  @ApiProperty({ description: 'Code/Key of the tenant this configuration belongs to', required: false })
  tenantCode?: string | null;

  /**
   * Whether this is a locked, platform-owned default (super-admin-only write).
   *
   * Surfaced so the SDK's `ConfigManager` can build its `lockedPaths` set and the
   * admin console can render the lock affordance / disable edits for non-super
   * admins. Server-side write protection is enforced independently in
   * `TenantService.updateTenantConfigs`; this flag is the read-side mirror. The
   * backing entity column is non-null (`@default(false)`), so the mapper always
   * populates it.
   */
  @ApiProperty({
    description: 'Whether the configuration is a locked, platform-owned default (super-admin-only write).',
    example: false,
    required: false,
  })
  locked?: boolean;

  /**
   * Optimistic-concurrency token.
   *
   * Clients must echo this value back as `expectedVersion` on the
   * subsequent PATCH; the server's compare-and-set fails with 412
   * Precondition Failed if `_version` has drifted under us.
   *
   * The response also carries an `ETag: "<version>"` header so SDK clients
   * can use the canonical RFC 7232 `If-Match` mechanism instead of
   * threading the field through the body; both shapes remain supported.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;

  constructor(props: TenantConfigResponseProps) {
    super(props);
    this.name = props.name;
    this.description = props.description;
    this.key = props.key;
    this.defaultValue = props.defaultValue;
    this.value = props.value;
    this.dataType = props.dataType;
    this.namespace = props.namespace;
    this.tenantId = props.tenantId;
    this.tenantCode = props.tenantCode;
    this.locked = props.locked;
    this.version = props.version;
  }
}
