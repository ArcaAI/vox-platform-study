import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-356 Phase 6 (S2) — the caller's preferred backend prompt template after a
 * set/clear. `null` means the doctor has no preference (resolution falls through
 * to the department/tenant default tiers — Phase 5 reads this back).
 */
export class PreferredPromptTemplateResponse {
  @ApiPropertyOptional({ description: "The caller's preferred prompt template id (null = no preference).", nullable: true })
  preferredPromptTemplateId: string | null;
}
