import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { AgentTask } from '@arcaai/domains';
import { PaginatedQuery } from '../../../common/dto';

/**
 * TASK-965 — the lineage register's query: `PaginatedQuery` plus the console's primary facet.
 *
 * `task` is a FIRST-CLASS field for the reason `ListWorkflowDefinitionsQuery.paletteKey` is one:
 * the generic `filters=task[equals]:…` grammar keeps working, but the natural guess (`?task=…`)
 * would otherwise be a 400 under `forbidNonWhitelisted`. The inherited `filters` / `search`
 * narrow the VERSION ROWS, so a lineage is listed when any of its live versions match.
 */
export class ListAgentLineagesQuery extends PaginatedQuery {
  @ApiPropertyOptional({ enum: AgentTask, description: 'Only lineages with a live version of this task.' })
  @IsOptional()
  @IsEnum(AgentTask)
  task?: AgentTask;
}
