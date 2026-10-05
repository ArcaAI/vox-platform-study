import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { AiActivityRunService } from './ai-activity-run.service';
import { IActivityRunRecordReader, IActivityRunRecordReaderToken, IAiActivityRunService, IAiActivityRunServiceToken } from './IAiActivityRunService';

/**
 * The AI activity run record: one service behind two contracts — the producer
 * (`IAiActivityRunService`) and the reader (`IActivityRunRecordReader`).
 *
 * Both are offered under their symbol token AND their abstract class, aliased
 * to the one instance. CoreDatabaseModule supplies the run, context-item and
 * named-entity repositories.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    AiActivityRunService,
    { provide: IAiActivityRunServiceToken, useExisting: AiActivityRunService },
    { provide: IAiActivityRunService, useExisting: AiActivityRunService },
    { provide: IActivityRunRecordReaderToken, useExisting: AiActivityRunService },
    { provide: IActivityRunRecordReader, useExisting: AiActivityRunService },
  ],
  exports: [IAiActivityRunServiceToken, IAiActivityRunService, IActivityRunRecordReaderToken, IActivityRunRecordReader, AiActivityRunService],
})
export class AiActivityRunServiceModule {}
