import { Module } from '@nestjs/common';
import { HighlightService } from './highlight.service';
import { IHighlightService } from './IHighlightService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    HighlightService,
    {
      provide: IHighlightService,
      // useExisting, not useClass — useClass would construct a second
      // HighlightService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: HighlightService,
    },
  ],
  exports: [IHighlightService, HighlightService],
})
export class HighlightServiceModule {}
