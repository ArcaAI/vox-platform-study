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

  constructor(init: GlobalSettingResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.description = init.description;
    this.key = init.key;
    this.value = init.value;
    this.dataType = init.dataType;
    this.namespace = init.namespace;
    this.version = init.version;
  }
}
