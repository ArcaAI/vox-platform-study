import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ITranscriptRecordService, ITranscriptRecordServiceToken } from './ITranscriptRecordService';
import { TranscriptRecordService } from './transcript-record.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    TranscriptRecordService,
    // Both handles alias the one instance: consumers inject the symbol token, the abstract
    // class stays usable as a type-safe token too.
    { provide: ITranscriptRecordServiceToken, useExisting: TranscriptRecordService },
    { provide: ITranscriptRecordService, useExisting: TranscriptRecordService },
  ],
  exports: [ITranscriptRecordServiceToken, ITranscriptRecordService, TranscriptRecordService],
})
export class TranscriptRecordServiceModule {}
