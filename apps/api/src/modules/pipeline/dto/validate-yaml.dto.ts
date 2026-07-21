import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Body-field alignment for `POST /admin/audio/pipelines/validate`.
 *
 * The SDK (`usePipelines.validateConfig`) posts `{ configYaml }` while the
 * legacy backend DTO expected `{ yaml }`. We accept BOTH names and require at
 * least one to be present. The controller calls `resolveYaml(body)` to pick
 * whichever is provided.
 */
export class ValidateYamlRequest {
  @ApiPropertyOptional({ description: 'YAML content to validate (SDK canonical field)' })
  @ValidateIf((o: ValidateYamlRequest) => !o.yaml || (typeof o.yaml === 'string' && o.yaml.length === 0))
  @IsString({ message: 'configYaml must be a string when yaml is not provided' })
  configYaml?: string;

  @ApiPropertyOptional({ description: 'YAML content to validate (legacy field)' })
  @ValidateIf((o: ValidateYamlRequest) => !o.configYaml || (typeof o.configYaml === 'string' && o.configYaml.length === 0))
  @IsString({ message: 'yaml must be a string when configYaml is not provided' })
  @IsOptional()
  yaml?: string;
}

/**
 * Pick whichever yaml-bearing field the SDK or admin tool sent. Empty string
 * is treated as missing.
 */
export function resolveYaml(request: ValidateYamlRequest): string {
  const candidate = request.configYaml ?? request.yaml;
  return typeof candidate === 'string' ? candidate : '';
}

export class ValidateYamlResponse {
  @ApiProperty({ description: 'Whether the YAML is valid' })
  valid!: boolean;

  @ApiPropertyOptional({ description: 'Validation errors if any', type: [String] })
  errors?: string[];
}
