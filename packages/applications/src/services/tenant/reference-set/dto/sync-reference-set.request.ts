import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional } from 'class-validator';
import { REFERENCE_SET_KINDS, type ReferenceSetKind, type ReferenceSetSyncMode } from '../ITenantReferenceSetService';

/** Body of `POST /admin/tenants/:id/reference-set/sync` (TASK-890 §3.4). */
export class SyncReferenceSetRequest {
  @ApiPropertyOptional({
    description:
      '`missing-only` (default) adds what the tenant lacks and touches nothing it has. `refresh-locked` additionally re-copies rows still marked `templateLocked` (pristine clones) and NEVER touches a row the tenant has edited.',
    enum: ['missing-only', 'refresh-locked'],
    default: 'missing-only',
  })
  @IsOptional()
  @IsIn(['missing-only', 'refresh-locked'])
  mode?: ReferenceSetSyncMode;

  @ApiPropertyOptional({
    description: 'Restrict the run to these kinds. Omit for the whole reference set.',
    isArray: true,
    enum: REFERENCE_SET_KINDS as unknown as string[],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(REFERENCE_SET_KINDS as unknown as string[], { each: true })
  kinds?: ReferenceSetKind[];
}
