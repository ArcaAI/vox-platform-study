import { IsInt, Min, ValidateIf, IsDefined } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Pin (or unpin) a DepartmentAgent to a specific PromptVersion number.
 * `versionNumber: null` clears the pin (track latest APPROVED). The field is
 * required (must be present as a number or explicit null) so an empty body is
 * rejected.
 */
export class PinDepartmentAgentRequest {
  @ApiProperty({
    description: 'PromptVersion number to pin to, or null to track the latest APPROVED version.',
    example: 3,
    nullable: true,
    type: Number,
  })
  @IsDefined()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(1)
  versionNumber!: number | null;
}
