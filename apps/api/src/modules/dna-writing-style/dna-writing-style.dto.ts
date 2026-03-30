import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DnaJobResponseDto {
  @ApiProperty({ description: 'BullMQ job ID' })
  jobId: string;

  @ApiProperty({ description: 'Job status', example: 'PENDING' })
  status: string;
}

export class DnaJobStatusResponseDto {
  @ApiProperty({ description: 'BullMQ job ID' })
  jobId: string;

  @ApiProperty({
    description: 'Current job status',
    enum: ['queued', 'processing', 'completed', 'failed'],
  })
  status: string;

  @ApiPropertyOptional({ description: 'Job result when completed' })
  result?: unknown;

  @ApiPropertyOptional({ description: 'Error message when failed' })
  error?: string;
}
