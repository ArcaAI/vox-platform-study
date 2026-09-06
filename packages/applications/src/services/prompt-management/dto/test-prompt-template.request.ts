import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, IsBoolean, IsUUID, Min } from 'class-validator';

/**
 * Request body for `POST /admin/prompt-templates/:id/test`.
 *
 * BUG-018 — this call NO LONGER blocks on the LLM and NO LONGER writes. It
 * assembles the prompt, resolves `{provider, model}`, submits a STREAMING
 * generation job to TEXT and returns a `PromptTestAckResponse` immediately.
 * Scoring and the optimistic-concurrency persist happen on the follow-up
 * `POST :id/test/finalize` call, which is where `expectedVersion`/`If-Match`
 * now belong.
 *
 *  - `provider`/`model` — caller-selected LLM (forwarded verbatim; omit both to
 *    resolve the assigned TEXT_GENERATION agent (tenant → department → SYSTEM, TASK-876). There is no
 *    `text.finalize` fallback: that was harness coupling, removed here).
 *  - `dryRun` — assemble and return the prompt WITHOUT generating anything at
 *    all (no TEXT call, no job, no tokens billed).
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
      'Caller-selected LLM provider, forwarded to TEXT verbatim (must be paired with `model`). ' +
      'Omit both to resolve the assigned TEXT_GENERATION agent (tenant → department → SYSTEM).',
    example: 'lm-studio',
  })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    description: 'Caller-selected LLM model, forwarded to TEXT verbatim (must be paired with `provider`).',
    example: 'medgemma-27b',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'TASK-890 §3.7 — a tenant-catalogue `AiModel` row id (the console picker). The server resolves the ACTUAL wire ' +
      '`{provider, model}` from this row — its routing identifier is never exposed to the browser (the catalogue DTO ' +
      'deliberately omits it). Mutually exclusive with `provider`/`model`; either selector wins over the resolved agent.',
  })
  @IsOptional()
  @IsUUID()
  modelId?: string;

  @ApiPropertyOptional({
    description: 'Assemble and return the prompt WITHOUT calling TEXT at all — no generation, no job, no tokens.',
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
