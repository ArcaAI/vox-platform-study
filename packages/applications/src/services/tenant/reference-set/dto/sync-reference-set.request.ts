import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional } from 'class-validator';
import { REFERENCE_SET_KINDS, type ReferenceSetKind, type ReferenceSetSyncMode } from '../ITenantReferenceSetService';

/** Body of `POST /admin/tenants/:id/reference-set/sync` (TASK-890 §3.4). */
export class SyncReferenceSetRequest {
  @ApiPropertyOptional({
    description:
      '`missing-only` (default) adds what the tenant lacks and touches nothing it has. `refresh-locked` is accepted but NOT IMPLEMENTED yet: it currently behaves as `missing-only` and the response says so in `warnings`. Its intent is to additionally re-copy rows still marked `templateLocked` (pristine clones) while never touching a row the tenant has edited.',
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
