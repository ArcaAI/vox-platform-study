import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ValidateYamlRequest {
  @ApiProperty({ description: 'YAML content to validate' })
  @IsString()
  @IsNotEmpty()
  yaml!: string;
}

export class ValidateYamlResponse {
  @ApiProperty({ description: 'Whether the YAML is valid' })
  valid!: boolean;

  @ApiPropertyOptional({ description: 'Validation errors if any', type: [String] })
  errors?: string[];
}
