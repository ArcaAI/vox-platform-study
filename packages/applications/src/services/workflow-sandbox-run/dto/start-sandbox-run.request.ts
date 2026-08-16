import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Body of `POST /api/v1/admin/workflow-definitions/:id/sandbox-runs` (TASK-721 Workbench).
 *
 * Both fields are optional and independent: `fixtureId` names a saved `WorkflowTestFixture`
 * (Phase B) whose `input` is used as the run payload; `input` is an inline payload that, when
 * present, WINS over `fixtureId` (explicit beats saved — mirrors "the caller's most specific
 * intent always wins" elsewhere in the platform). Neither supplied -> `{}`, the same default
 * `InterpreterInput.payload` carries. The global `ValidationPipe` runs `forbidNonWhitelisted`,
 * so any other body field is a 400, not a silently-ignored extra.
 */
export class StartSandboxRunRequest {
  @ApiPropertyOptional({ description: 'A saved WorkflowTestFixture id — its `input` is used as the run payload.' })
  @IsOptional()
  @IsString()
  fixtureId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Inline synthetic test input, forwarded verbatim as the run payload. Wins over `fixtureId` when both are supplied.',
    example: {},
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
