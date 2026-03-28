import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class DtoRecord {
  @ApiProperty({ example: '0189f7ea-ae2f-72b9-9be8-9c3d224082ef' })
  @IsString()
  id!: string;

  @ApiProperty()
  @IsString()
  value!: string;
}
