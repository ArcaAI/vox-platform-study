import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import type { CancelModelDownloadRequest as CancelModelDownloadRequestContract } from '@arcaai/types';

/** `POST admin/ai-models/:id/download/cancel` body (TASK-1023 D-C, OD-5). */
export class CancelModelDownloadRequest implements CancelModelDownloadRequestContract {
  @ApiPropertyOptional({
    description: 'Also unregister the model (and delete any weights) once the download is cancelled. Default false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  removeRegistration?: boolean;
}
