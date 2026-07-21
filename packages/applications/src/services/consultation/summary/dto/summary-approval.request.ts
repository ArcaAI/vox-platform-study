import { IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SummaryApprovalRequest {
  @ApiPropertyOptional({
    description:
      'One-click clinician acknowledgement to sign past a safety FLAG. ' +
      'Recorded as a SAFETY_OVERRIDE WORM audit event; no free-text justification required.',
  })
  @IsOptional()
  @IsBoolean()
  overrideSafetyFlag?: boolean;
}
