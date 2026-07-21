import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { BaseRequest } from '../../../common';
import { EntityId } from '@arcaai/domains';
import { EntityIdProperty } from '../../../decorators';

export class UpdateTenantConfigRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the configuration' })
  @EntityIdProperty()
  id!: EntityId;

  @ApiProperty({ description: 'Description of the configuration', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Value for the configuration' })
  @IsString()
  value!: string;

  /**
   * Optimistic-concurrency token.
   * Must equal the row's current `_version`; the bulk update inside a single
   * `$transaction` is all-or-nothing on conflict and returns 412 Precondition
   * Failed if any row's version drifted since the prior GET.
   *
   * @see `04-optimistic-locking.md`
   */
  @ApiProperty({
    description: "Current version of the row (from the prior GET). The PATCH fails with 412 if any row's version drifted.",
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
