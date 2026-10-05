import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

/** TASK-1036 OD-15 — one tenant media object attached to a sandbox run, by reference. */
export class SandboxAttachmentRequest {
  @ApiProperty({ description: 'A Media id of the caller tenant (uploaded first). Its MIME type must be on the attachment allow-list.' })
  @IsString()
  @IsNotEmpty()
  mediaId: string;
}

/** TASK-1036 OD-15 — the Test tab's live recording: an STT streaming session the run binds to its sandbox consultation. */
export class SandboxRecordingRequest {
  @ApiProperty({ description: 'An STT streaming session id of the caller tenant (`POST …/stream/session`).' })
  @IsString()
  @IsNotEmpty()
  sttSessionId: string;
}

/**
 * Body of `POST /api/v1/admin/workflow-definitions/:id/sandbox-runs` ( Workbench).
 *
 * Both fields are optional and independent: `fixtureId` names a saved `WorkflowTestFixture`
 *  whose `input` is used as the run payload; `input` is an inline payload that, when
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

  @ApiPropertyOptional({
    type: [SandboxAttachmentRequest],
    description: 'TASK-1036 — tenant media to attach, by id. Forwarded to the run as `{ mediaId, mime, name, size }`, never as bytes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SandboxAttachmentRequest)
  attachments?: SandboxAttachmentRequest[];

  @ApiPropertyOptional({
    type: SandboxRecordingRequest,
    description: 'TASK-1036 — a live STT session; the run creates a sandbox consultation, binds the session to it and runs against it.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SandboxRecordingRequest)
  recording?: SandboxRecordingRequest;
}
