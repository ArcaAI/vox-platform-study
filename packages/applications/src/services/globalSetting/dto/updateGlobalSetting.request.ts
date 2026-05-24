import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsInt, Min } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ValueType } from '@arcaai/domains';

export class UpdateGlobalSettingRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the global setting', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Description of the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Unique key for the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  key?: string;

  @ApiProperty({
    description: 'Value of the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  value?: string;

  @ApiProperty({
    description: 'Data type of the global setting',
    enum: ValueType,
    required: false,
  })
  @IsEnum(ValueType)
  @IsOptional()
  dataType?: ValueType;

  @ApiProperty({
    description: 'Namespace for the global setting',
    required: false,
  })
  @IsString()
  @IsOptional()
  namespace?: string;

  /**
   * Optimistic-concurrency token — TASK-302 Stream D Phase C (C.1/C.7).
   *
   * Required. The client must read the row first, then echo back the
   * `version` it observed. The service issues a Compare-And-Set
   * (`Repository.updateWithVersion`) and fails with
   * `OptimisticConcurrencyException` -> HTTP 412 Precondition Failed
   * if `_version` has drifted under the client between read and write.
   *
   * Phase D's `ETagInterceptor` + `@RequiresIfMatch()` will expose the
   * canonical RFC 7232 `If-Match` mechanism; the body field stays as
   * the service-to-service fallback per the plan's two-shapes-accepted
   * rule.
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
