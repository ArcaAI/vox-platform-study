import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantPlan } from '@arcaai/domains';
import { BaseResponse, BaseResponseProps } from '../../../common';

export class TenantResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the tenant' })
  name!: string;

  @ApiProperty({ description: 'Unique key for the tenant' })
  key!: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  description?: string;

  /**
   * Commercial plan. Nullable/undefined when unspecified
   * (existing tenants read no plan).
   */
  @ApiPropertyOptional({ description: 'Commercial plan', enum: TenantPlan })
  plan?: TenantPlan | null;

  /**
   * Free-form tenant tags (reuses the existing
   * `Tenant.tags String[]` scalar).
   */
  @ApiProperty({ description: 'Tenant tags', type: [String], default: [] })
  tags!: string[];

  /**
   * Row version for optimistic concurrency control. Clients echo this back
   * via `If-Match: "<version>"` (or `expectedVersion` in the body for
   * service-to-service callers) on the next PATCH. The server's
   * compare-and-set (`tenantRepository.updateWithVersion`) fails with `412
   * Precondition Failed` if `_version` has drifted under the client between
   * read and write.
   *
   * The `ETagInterceptor` also stamps `ETag: "<version>"`
   * on the response so SDK clients can use the canonical RFC 7232
   * `If-Match` mechanism without parsing the body.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;

  constructor(init: TenantResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.key = init.key;
    this.description = init.description;
    this.plan = init.plan ?? null;
    this.tags = init.tags ?? [];
    this.version = init.version;
  }
}
