import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { applyDecorators } from '@nestjs/common';

export function ResourceIdProperty(options?: ApiPropertyOptions): PropertyDecorator {
  const defaultOptions: ApiPropertyOptions = {
    example: '0189f7ea-ae2f-72b9-9be8-9c3d224082ef',
  };

  const finalOptions = { ...defaultOptions, ...options } as ApiPropertyOptions;

  return applyDecorators(ApiProperty(finalOptions), IsString());
}

export function ResourceIdPropertyOptional(options?: ApiPropertyOptions): PropertyDecorator {
  const defaultOptions: ApiPropertyOptions = {
    example: '0189f7ea-ae2f-72b9-9be8-9c3d224082ef',
    required: false,
  };

  const finalOptions = { ...defaultOptions, ...options } as ApiPropertyOptions;

  return applyDecorators(ApiProperty(finalOptions), IsString(), IsOptional());
}
