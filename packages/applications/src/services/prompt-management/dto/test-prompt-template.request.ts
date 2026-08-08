import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, IsBoolean, IsUUID, Min } from 'class-validator';

/**
 * Request body for `POST /admin/prompt-templates/:id/test`.
 *
 * Runs the template against the SMR/text-generation service and — unless
 * `dryRun` is set — persists the resulting score/output via an
 * optimistic-concurrency write, so it carries the same `expectedVersion`
 * predicate as the PATCH route (folded from the `If-Match` header at the
 * controller).
 *
 * TASK-635 Lane B additions:
 *  - `provider`/`model` — caller-selected LLM (forwarded verbatim; falls back
 *    to the `smr.test` → `smr.finalize` AiTaskDefault cascade when omitted).
 *  - `dryRun` — score/generate without persisting `lastTest*` or bumping
 *    `_version`.
 *  - `versionNumber` — test an immutable pinned `PromptVersion` snapshot
 *    instead of the mutable draft.
 *  - `goldenCaseId` — feed a decrypted golden-case transcript as the sample
 *    input instead of free-text `sampleInput` (mutually exclusive with it).
 */
export class TestPromptTemplateRequest {
  @ApiPropertyOptional({
    description: 'Sample values to interpolate into the template `{{variables}}` for the test run',
  })
  @IsOptional()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optional extra sample input appended to the prompt. Mutually exclusive with `goldenCaseId`.' })
  @IsOptional()
  @IsString()
  sampleInput?: string;

  @ApiPropertyOptional({
    description: 'Row version for optimistic concurrency control. Echoed from `If-Match: "<version>"` (header wins when both are present).',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  @ApiPropertyOptional({
    description:
      'Caller-selected LLM provider, forwarded to SMR verbatim (must be paired with `model`). ' +
      'Omit both to resolve the tenant `smr.test` AiTaskDefault, falling back to `smr.finalize` when unset.',
    example: 'lm-studio',
  })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    description: 'Caller-selected LLM model, forwarded to SMR verbatim (must be paired with `provider`).',
    example: 'medgemma-27b',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description: 'Score/generate without persisting `lastTestScore/lastTestOutput/lastTestAt` or bumping the row `_version`.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'Test the immutable `PromptVersion` snapshot at this version number instead of the mutable draft. 404 if the version does not exist.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;

  @ApiPropertyOptional({
    description:
      'Golden-case id whose decrypted transcript feeds the test run as sample input. Mutually exclusive with `sampleInput`; cross-tenant ids 404.',
  })
  @IsOptional()
  @IsUUID()
  goldenCaseId?: string;
}
