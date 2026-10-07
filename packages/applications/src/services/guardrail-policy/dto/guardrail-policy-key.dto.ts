import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsInt, IsOptional, Min } from 'class-validator';

/** The newest revision of one key on its model row (no value: the list stays small). */
export class GuardrailPolicyRevisionSummaryResponse {
  @ApiProperty({ description: 'Revision id (uuidv7).' })
  id!: string;

  @ApiProperty({ description: '`edit` | `reset` | `restore` | `seed`.', example: 'edit' })
  reason!: string;

  @ApiProperty({ description: 'The user who wrote it.' })
  actorId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC.' })
  at!: string;

  @ApiProperty({ description: 'sha256 (hex) of the canonical JSON of the value.' })
  valueHash!: string;
}

/** One governed key, as the platform editor needs it. Bounds are echoed from the catalogue artifact. */
export class GuardrailPolicyKeyEntryResponse {
  @ApiProperty({
    example: 'judgeTemperature',
    description:
      'A catalogue key (`_metadata.policy`), or a classifier threshold inside `_metadata.labelTaxonomy`: `labelTaxonomy.threshold` / `labelTaxonomy.tasks.<task>.cls_threshold` (single-key routes then need `?taskKey=`).',
  })
  key!: string;

  @ApiProperty({ description: '`criteria` | `hyperparameter` | `threshold` | `geometry` | `operational`.' })
  kind!: string;

  @ApiProperty({ description: '`string` | `number` | `integer` | `boolean` | `string[]` | `object`.' })
  type!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'Inclusive lower bound from the catalogue; `null` when unbounded.' })
  min!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Inclusive upper bound from the catalogue; `null` when unbounded.' })
  max!: number | null;

  @ApiProperty({ description: '`closed` | `open-to-default`.' })
  failMode!: string;

  @ApiProperty({ description: 'The `AiRoutingPolicy` task key of the SYSTEM model row the key lives on.', example: 'guardrail.validate' })
  taskKey!: string;

  @ApiProperty({ description: 'A change re-screens (busts the window-verdict cache).' })
  inPolicyVersion!: boolean;

  @ApiProperty({ description: 'Writable through `PUT admin/guardrail/policy-keys/:key`.' })
  editable!: boolean;

  @ApiProperty({ nullable: true, type: String, description: 'The safety-judge lane whose template a criteria key follows, else `null`.' })
  lane!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'The SYSTEM model row (`AiModel.id`) the key lives on; `null` when the task key elects no model.' })
  modelId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  modelSlug!: string | null;

  @ApiProperty({ nullable: true, type: Number, description: 'The model row `_version`: send it as `If-Match` on `PUT`.' })
  modelVersion!: number | null;

  @ApiProperty({ nullable: true, description: '`_metadata.policy[key]`; `null` when unset.' })
  currentValue!: unknown;

  @ApiProperty({ nullable: true, description: '`_metadata.policyDefaults[key]` (seed-owned, never written by the API); `null` when the seed ships none.' })
  defaultValue!: unknown;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['seed', 'current'],
    description:
      '`seed`: the default is seed-owned (`policyDefaults` / `labelTaxonomyDefaults`). `current`: a label threshold with no seeded default yet — the current value is reported as the default. `null`: none.',
  })
  defaultSource?: 'seed' | 'current' | null;

  @ApiProperty({ description: 'The current value equals the default (both absent counts as equal).' })
  isDefault!: boolean;

  @ApiProperty({ type: GuardrailPolicyRevisionSummaryResponse, nullable: true })
  lastRevision!: GuardrailPolicyRevisionSummaryResponse | null;
}

/** All keys of one model row (one `taskKey`). */
export class GuardrailPolicyKeyGroupResponse {
  @ApiProperty({ example: 'guardrail.validate' })
  taskKey!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The judge lane this task key selects a model for, else `null`.' })
  lane!: string | null;

  @ApiProperty({ nullable: true, type: String })
  modelId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  modelSlug!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  modelVersion!: number | null;

  @ApiProperty({ nullable: true, type: String, description: '`_metadata.judge.protocol` of the model, when it declares one.' })
  protocol!: string | null;

  @ApiProperty({ type: [GuardrailPolicyKeyEntryResponse] })
  keys!: GuardrailPolicyKeyEntryResponse[];
}

export class GuardrailPolicyKeysResponse {
  @ApiProperty({ description: 'False when the catalogue artifact is unavailable (then no key is writable).' })
  catalogueAvailable!: boolean;

  @ApiProperty({ type: [GuardrailPolicyKeyGroupResponse] })
  groups!: GuardrailPolicyKeyGroupResponse[];
}

/** A single-key read or write. `version` is the MODEL ROW `_version` (the ETag). */
export class GuardrailPolicyKeyResponse extends GuardrailPolicyKeyEntryResponse {
  @ApiProperty({ description: 'The model row `_version` after the operation (also the strong ETag).' })
  version!: number;

  @ApiPropertyOptional({ description: 'False for an idempotent no-op (the value already equalled the target); no revision was appended.' })
  changed?: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'The revision this write appended, when it changed something.' })
  revisionId?: string | null;
}

export class UpdateGuardrailPolicyKeyRequest {
  @ApiProperty({
    description: 'The new value. Validated against the catalogue entry (type, bounds) and, for a safety-judge criteria key, the judge template (locked sections, lane categories).',
    example: 0.05,
  })
  @IsDefined()
  value!: unknown;

  @ApiPropertyOptional({ description: 'The model row version the client read. The `If-Match` header overrides it.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

/** One revision, with its value, for the history view and diff. */
export class GuardrailPolicyRevisionResponse extends GuardrailPolicyRevisionSummaryResponse {
  @ApiProperty()
  aiModelId!: string;

  @ApiProperty()
  policyKey!: string;

  @ApiProperty({ description: 'The value this revision set.' })
  value!: unknown;

  @ApiProperty({ nullable: true, type: String })
  restoredFromRevisionId!: string | null;
}

export class GuardrailPolicyRevisionsResponse {
  @ApiProperty()
  key!: string;

  @ApiProperty({ nullable: true, type: String })
  modelId!: string | null;

  @ApiProperty({ type: [GuardrailPolicyRevisionResponse], description: 'Newest first.' })
  revisions!: GuardrailPolicyRevisionResponse[];
}

/** `POST admin/guardrail/policy-keys/reset?lane=` — one entry per key the reset touched. */
export class GuardrailPolicyLaneResetResponse {
  @ApiProperty({ description: 'The task key (model row) that was reset.' })
  taskKey!: string;

  @ApiProperty({ nullable: true, type: Number })
  version!: number | null;

  @ApiProperty({ type: [String], description: 'Keys whose current value changed (each has a new `reset` revision).' })
  resetKeys!: string[];

  @ApiProperty({ type: [String], description: 'Keys skipped: already at default, no default shipped, or not editable.' })
  skippedKeys!: string[];
}
