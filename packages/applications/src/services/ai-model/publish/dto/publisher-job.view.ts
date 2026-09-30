import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PUBLISHER_JOB_STATES, type PublisherJobState, type PublisherJobView as PublisherJobViewContract } from '@arcaai/types';

export class PublisherJobErrorView {
  @ApiProperty() code: string;
  @ApiProperty() message: string;
}

/** One row of `GET admin/ai-models/jobs` (TASK-1023 D-C). */
export class PublisherJobView implements PublisherJobViewContract {
  @ApiProperty() jobId: string;
  @ApiProperty({ enum: ['download', 'unregister'] }) kind: 'download' | 'unregister';
  @ApiProperty() aiModelId: string;
  @ApiProperty({ description: 'Empty when the row is gone and the job carried no slug.' }) modelSlug: string;
  @ApiProperty() modelName: string;
  @ApiProperty({ enum: PUBLISHER_JOB_STATES }) state: PublisherJobState;
  @ApiProperty({ nullable: true, type: Number }) bytesDone: number | null;
  @ApiProperty({ nullable: true, type: Number }) bytesTotal: number | null;
  @ApiProperty({ description: 'ISO timestamp.' }) startedAt: string;
  @ApiProperty({ nullable: true, type: String, description: 'ISO timestamp.' }) finishedAt: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'User id that started the job, when known.' }) startedBy: string | null;
  @ApiProperty({ nullable: true, type: PublisherJobErrorView }) error: PublisherJobErrorView | null;
}

/** `GET admin/ai-models/jobs?limit=` — default 50, max 200. */
export class ListPublisherJobsQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
