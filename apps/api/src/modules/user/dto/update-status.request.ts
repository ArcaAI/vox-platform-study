import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';

export class UpdateUserStatusRequest {
  @ApiProperty({
    description: 'The new resource status for the user',
    enum: ['ENABLED', 'DISABLED'],
    example: 'ENABLED',
  })
  @IsNotEmpty()
  @IsEnum(['ENABLED', 'DISABLED'])
  resourceStatus!: string;
}
