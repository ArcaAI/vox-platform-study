import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Request body for `POST /admin/prompt-templates/:id/test/finalize`.
 *
 * BUG-018 — closes the two-call test run: the gateway fetches the FINISHED
 * generation from SMR server-side (`GET /api/v1/tasks/<taskId>`), scores it, and
 * persists `lastTestScore/lastTestOutput/lastTestAt` under optimistic
 * concurrency.
 *
 * The generated text is DELIBERATELY not accepted from the client — the browser
 * saw the same tokens over SSE, but taking them from the request body would let
 * any caller forge `lastTestOutput` on the row.
 */
export class FinalizePromptTestRequest {
  @ApiProperty({ description: 'SMR generation task id returned by the `:id/test` ack', example: '0f1c…' })
  @IsString()
  taskId: string;

  @ApiPropertyOptional({
    description: 'Row version for optimistic concurrency control. Echoed from `If-Match: "<version>"` (header wins when both are present).',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  /**
   * Echo of the `versionNumber` the run was STARTED with. Scoring reads the
   * tested content/variables, so a run against a pinned `PromptVersion` must be
   * scored against that same snapshot — without this the split would silently
   * score a pinned run against the mutable draft.
   */
  @ApiPropertyOptional({
    description:
      'The `versionNumber` the matching `:id/test` call was started with, when it pinned a `PromptVersion`. ' +
      'Omit for a draft run. Scoring uses this snapshot, so it must match the submitted run.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;
}
