import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, IsBoolean, IsUUID, Min } from 'class-validator';

/**
 * Request body for `POST /admin/prompt-templates/:id/test`.
 *
 * BUG-018 — this call NO LONGER blocks on the LLM and NO LONGER writes. It
 * assembles the prompt, resolves `{provider, model}`, submits a STREAMING
 * generation job to SMR and returns a `PromptTestAckResponse` immediately.
 * Scoring and the optimistic-concurrency persist happen on the follow-up
 * `POST :id/test/finalize` call, which is where `expectedVersion`/`If-Match`
 * now belong.
 *
 *  - `provider`/`model` — caller-selected LLM (forwarded verbatim; omit both to
 *    resolve the `text.test` AiTaskDefault, tenant row → SYSTEM row. There is no
 *    `text.finalize` fallback: that was harness coupling, removed here).
 *  - `dryRun` — assemble and return the prompt WITHOUT generating anything at
 *    all (no SMR call, no job, no tokens billed).
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
    description: 'DEPRECATED on this route (BUG-018) — the test submit no longer writes. Supply it on `:id/test/finalize` instead.',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  @ApiPropertyOptional({
    description:
      'Caller-selected LLM provider, forwarded to SMR verbatim (must be paired with `model`). ' +
      'Omit both to resolve the `text.test` AiTaskDefault (tenant row → SYSTEM row).',
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
    description: 'Assemble and return the prompt WITHOUT calling SMR at all — no generation, no job, no tokens.',
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
