import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNotEmpty } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ValueType } from '@arcaai/domains';

export class CreateGlobalSettingRequest extends BaseRequest {
    @ApiProperty({ description: 'Name of the global setting' })
    @IsString()
    @IsNotEmpty()
    name!: string;

    @ApiProperty({
        description: 'Description of the global setting',
        required: false
    })
    @IsString()
    @IsOptional()
    description?: string;

    @ApiProperty({ description: 'Unique key for the global setting' })
    @IsString()
    @IsNotEmpty()
    key!: string;

    @ApiProperty({ description: 'Value of the global setting' })
    @IsString()
    @IsNotEmpty()
    value!: string;

    @ApiProperty({
        description: 'Data type of the global setting',
        enum: ValueType
    })
    @IsEnum(ValueType)
    @IsNotEmpty()
    dataType: ValueType = ValueType.String;

    @ApiProperty({
        description: 'Namespace for the global setting',
        required: false
    })
    @IsString()
    @IsOptional()
    namespace?: string;
}
