import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Immediate acknowledgement of `POST /admin/prompt-templates/:id/test`.
 *
 * BUG-018 — the test run no longer blocks on the LLM completion (2–3½ minutes
 * of generation reached the browser as a CDN 524). The route now returns in well
 * under a second:
 *
 *  - `mode: 'stream'` — SMR accepted a streaming generation job. Open
 *    `streamUrl` (SSE, single-use stream ticket, `text_task:<taskId>` scope) to
 *    render tokens, then call `POST :id/test/finalize` with the `taskId` to
 *    score and persist the result.
 *  - `mode: 'dry-run'` — NOTHING was generated. `assembledPrompt` is the fully
 *    interpolated prompt so the author can inspect exactly what would be sent.
 *
 * `assembledPrompt` is present in BOTH modes; `taskId`/`streamUrl` only in
 * stream mode.
 */
export class PromptTestAckResponse {
  @ApiProperty({
    description: "'stream' = a generation job was submitted; 'dry-run' = nothing was generated",
    enum: ['stream', 'dry-run'],
    example: 'stream',
  })
  mode: 'stream' | 'dry-run';

  @ApiProperty({ description: 'Resolved LLM provider for the run', example: 'azure-openai' })
  provider: string;

  @ApiProperty({ description: 'Resolved LLM model for the run', example: 'gpt-4o' })
  model: string;

  @ApiProperty({ description: 'The fully interpolated prompt that was (or would be) sent to SMR' })
  assembledPrompt: string;

  @ApiPropertyOptional({ description: 'SMR generation task id (stream mode only)', example: '0f1c…' })
  taskId?: string;

  @ApiPropertyOptional({
    description: 'Gateway-relative SSE path for the generation stream (stream mode only)',
    example: 'text/tasks/0f1c…/stream',
  })
  streamUrl?: string;
}
