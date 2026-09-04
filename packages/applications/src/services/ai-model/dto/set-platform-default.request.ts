import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum } from 'class-validator';
import { AiTaskKind } from '@arcaai/domains';

/**
 * `PATCH admin/ai-models/:id/platform-default` — the super-admin "platform
 * default for task" election (TASK-860 §3.7). Replaces the row's election
 * with `tasks` and clears each of those tasks from whichever ENABLED row held
 * it before, so a task never has two defaults. An empty list withdraws the
 * row from every election.
 *
 * This ONLY writes `AiModel.isPlatformDefaultFor` and emits a sys-event; the
 * SYSTEM `AiRoutingPolicy` election it seeds is TASK-862's.
 */
export class SetPlatformDefaultRequest {
  @ApiProperty({
    description: 'The tasks this row is the platform default for.',
    enum: AiTaskKind,
    isArray: true,
    example: [AiTaskKind.SPEECH_TO_TEXT],
  })
  @IsArray()
  @IsEnum(AiTaskKind, { each: true })
  tasks: AiTaskKind[];
}
