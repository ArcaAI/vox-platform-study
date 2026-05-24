import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';

export class TenantResponse extends BaseResponse {
  @ApiProperty({ description: 'Name of the tenant' })
  name!: string;

  @ApiProperty({ description: 'Unique key for the tenant' })
  key!: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  description?: string;

  /**
   * Row version for optimistic concurrency control (TASK-302 Stream D
   * Phase E.1). Clients echo this back via `If-Match: "<version>"` (or
   * `expectedVersion` in the body for service-to-service callers) on
   * the next PATCH. The server's compare-and-set
   * (`tenantRepository.updateWithVersion`) fails with `412 Precondition
   * Failed` if `_version` has drifted under the client between read and
   * write.
   *
   * The `ETagInterceptor` (Phase D.1) also stamps `ETag: "<version>"`
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
    this.version = init.version;
  }
}
