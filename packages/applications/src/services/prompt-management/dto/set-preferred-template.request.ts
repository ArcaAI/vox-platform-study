import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * TASK-356 Phase 6 (S2) — doctor self-service "set my preferred template" body.
 * `templateId: null` CLEARS the preference (revert to department/tenant default).
 * The service validates the template is available to the caller via
 * `listAvailableForCaller` before writing `UserProfile.preferredPromptTemplateId`.
 */
export class SetPreferredTemplateRequest {
  @ApiProperty({ description: 'Prompt template id to prefer (null clears the preference).', nullable: true })
  @IsOptional()
  @IsString()
  templateId!: string | null;
}
