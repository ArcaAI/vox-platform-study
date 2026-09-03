import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Set a tenant's instruction content for an `nlp.topic` / `nlp.intent` task
 * key. The task key travels in the route. `instructionsJson` carries the
 * tenant's topic list / intent list — never a model selection field.
 * `expectedVersion` is the OCC token: `0` = create the row (none yet), `>0` =
 * compare-and-set against the current `_version` (drift → 412). The
 * controller folds the RFC 7232 `If-Match` header over this.
 *
 * SHAPE DECISION (OPEN, flagged Task 3 — not a settled fact):
 * both `nlp.topic` and `nlp.intent` use a plain `string[]` label list, the
 * same shape for both task keys. The plan named a richer `{label,
 * description}[]` alternative for `nlp.intent` (an intent description can
 * sharpen the LLM prompt Task 4/5 assembles); this ticket does NOT build that
 * Karpathy (no speculative richness without a demonstrated need). If the
 * prompt quality genuinely needs per-intent descriptions, upgrading this
 * field to a richer shape is a small, isolated follow-up (validator +
 * `apps/nlp`'s prompt assembly only — the storage column is untyped `Json?`
 * and needs no migration).
 */
export class UpsertTenantNlpTaskInstructionsRequest {
  @ApiPropertyOptional({
    description: 'Tenant-authored topic list / intent list — a plain string[] of labels (see the SHAPE DECISION note on this class).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  instructionsJson?: string[];

  @ApiPropertyOptional({
    description: 'OCC token. 0 = create (no row yet); >0 = compare-and-set against the current version (412 on drift).',
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
