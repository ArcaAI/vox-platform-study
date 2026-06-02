import { ApiProperty } from '@nestjs/swagger';
import { ContextItemVersionResponse } from './context-item.response';

/**
 * Response for diffing two versions of a summary / context item.
 *
 * The two version snapshots are returned verbatim; the visual diff is
 * computed client-side (e.g. the `version-diff-panel` in the playground)
 * so the backend stays presentation-agnostic.
 */
export class VersionDiffResponse {
  @ApiProperty({ description: 'Context item being diffed' })
  contextItemId: string;

  @ApiProperty({ description: 'The earlier ("from") version snapshot', type: ContextItemVersionResponse })
  from: ContextItemVersionResponse;

  @ApiProperty({ description: 'The later ("to") version snapshot', type: ContextItemVersionResponse })
  to: ContextItemVersionResponse;
}
