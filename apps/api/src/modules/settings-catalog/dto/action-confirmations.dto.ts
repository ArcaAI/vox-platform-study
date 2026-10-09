import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Literal copies of `CONFIRMATION_KINDS` / `CONFIRMATION_MODES` (@arcaai/types): apps/api does not
// depend on that package, and a DTO enum is documentation + validation, not the source of truth.
const CONFIRMATION_KINDS = ['reason', 'evidence', 'acknowledgement', 'typeToConfirm', 'reasonCode', 'breakGlass', 'stepUp'] as const;
const CONFIRMATION_MODES = ['required', 'when-risky', 'not-required'] as const;

/** One resolved action confirmation — what a dialog needs. */
export class EffectiveActionConfirmationResponse {
  @ApiProperty({ example: 'promptTemplate.update' })
  actionId!: string;

  @ApiProperty({ enum: CONFIRMATION_KINDS })
  kind!: string;

  @ApiProperty({ enum: CONFIRMATION_MODES })
  mode!: string;

  @ApiProperty({ description: 'Locked rows can never be switched off.' })
  locked!: boolean;

  @ApiPropertyOptional()
  minLength?: number;

  @ApiPropertyOptional()
  maxLength?: number;
}

export class EffectiveActionConfirmationsResponse {
  @ApiProperty({ type: [EffectiveActionConfirmationResponse] })
  items!: EffectiveActionConfirmationResponse[];
}

/** One catalogue row on the platform screen. */
export class ActionConfirmationPlatformRowResponse {
  @ApiProperty()
  actionId!: string;

  @ApiProperty({ description: 'Grouping label (the domain).' })
  domain!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: CONFIRMATION_KINDS })
  kind!: string;

  @ApiProperty({ enum: ['platform', 'tenant', 'both'] })
  audience!: string;

  @ApiProperty({ enum: ['server', 'console'], description: 'Where the requirement is enforced.' })
  enforcement!: string;

  @ApiProperty({ enum: CONFIRMATION_MODES, description: 'Today’s behaviour — the code default.' })
  default!: string;

  @ApiProperty({ enum: CONFIRMATION_MODES, isArray: true, description: 'The modes this row may hold.' })
  modes!: readonly string[];

  @ApiProperty()
  locked!: boolean;

  @ApiPropertyOptional()
  minLength?: number;

  @ApiPropertyOptional()
  maxLength?: number;

  @ApiProperty({ type: [String], description: 'Gateway route(s) the action reaches.' })
  routes!: readonly string[];

  @ApiProperty({ enum: CONFIRMATION_MODES, description: 'The effective mode.' })
  mode!: string;

  @ApiProperty({ enum: ['system', 'default', 'locked'], description: 'Which tier supplied the mode.' })
  source!: string;

  @ApiProperty({ description: 'Backing SYSTEM row version, read fresh; 0 when no row is stored. Echo as `expectedVersion`.', example: 0 })
  version!: number;
}

export class ActionConfirmationPlatformRowsResponse {
  @ApiProperty({ type: [ActionConfirmationPlatformRowResponse] })
  items!: ActionConfirmationPlatformRowResponse[];
}

/** One cell edit. `mode: null` resets to the catalogue default. */
export class ActionConfirmationWriteRequest {
  @ApiProperty({ example: 'promptTemplate.update' })
  @IsString()
  actionId!: string;

  @ApiProperty({
    nullable: true,
    enum: CONFIRMATION_MODES,
    description: 'The new mode. `null` resets the row to the catalogue default.',
  })
  // `null` is a MEANING (reset): see FeatureMatrixWriteRequest.value.
  // `@IsDefined` would reject `null` too (it fails on null AND undefined), which made reset
  // impossible. `null` skips validation (= reset); anything else, `undefined` included, must be a mode.
  @ValidateIf((cell: { mode?: unknown }) => cell.mode !== null)
  @IsIn([...CONFIRMATION_MODES], { message: '`mode` must be required, when-risky, not-required or null.' })
  mode!: 'required' | 'when-risky' | 'not-required' | null;

  @ApiPropertyOptional({ description: 'The `version` from the prior read. Omit for a row that has no stored value.', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ActionConfirmationWriteBatchRequest {
  @ApiProperty({ type: [ActionConfirmationWriteRequest], description: 'The edits to apply, in order. Capped at 200.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActionConfirmationWriteRequest)
  cells!: ActionConfirmationWriteRequest[];
}

export class ActionConfirmationErrorResponse {
  @ApiProperty()
  actionId!: string;

  @ApiProperty({ description: 'The status this cell would have produced alone (412 drift, 400 refused).', example: 400 })
  status!: number;

  @ApiProperty()
  message!: string;
}

export class ActionConfirmationWriteResponse {
  @ApiProperty({ type: [ActionConfirmationPlatformRowResponse], description: 'The touched rows, re-read AFTER the batch.' })
  rows!: ActionConfirmationPlatformRowResponse[];

  @ApiProperty({ type: [ActionConfirmationErrorResponse], description: 'Per-cell failures; the batch is ordered and partial.' })
  errors!: ActionConfirmationErrorResponse[];
}
