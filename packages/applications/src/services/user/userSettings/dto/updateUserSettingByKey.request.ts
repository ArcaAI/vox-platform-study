import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { BaseRequest } from '../../../../common';
import { ValueType } from '@arcaai/domains';

/**
 * Request DTO for PATCH /user/me/settings/:namespace/:key.
 * Updates a specific setting by namespace and key.
 */
export class UpdateUserSettingByKeyRequest extends BaseRequest {
    @ApiProperty({ description: 'Value of the setting' })
    @IsString()
    value!: string;

    @ApiPropertyOptional({
        description: 'Data type of the setting value',
        enum: ValueType,
    })
    @IsOptional()
    @IsEnum(ValueType)
    dataType?: ValueType;

    @ApiPropertyOptional({ description: 'Display name of the setting' })
    @IsOptional()
    @IsString()
    name?: string;
}
