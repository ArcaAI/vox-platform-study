import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { BaseRequest } from '../../../../common';
import { ValueType } from '@arcaai/domains';

export class UpdateUserSettingsRequest extends BaseRequest {
    @ApiProperty({ description: 'Name of the setting', required: false })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiProperty({ description: 'Key of the setting', required: false })
    @IsString()
    @IsOptional()
    key?: string;

    @ApiProperty({ description: 'Value of the setting', required: false })
    @IsString()
    @IsOptional()
    value?: string;

    @ApiProperty({
        description: 'Data type of the setting value',
        enum: ValueType,
        required: false
    })
    @IsEnum(ValueType)
    @IsOptional()
    dataType?: ValueType;

    @ApiProperty({ description: 'Namespace of the setting', required: false })
    @IsString()
    @IsOptional()
    namespace?: string;
}
