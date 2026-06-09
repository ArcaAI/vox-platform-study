import { Module } from '@nestjs/common';
import { HighlightService } from './highlight.service';
import { IHighlightService } from './IHighlightService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IHighlightService,
      useClass: HighlightService,
    },
    HighlightService,
  ],
  exports: [IHighlightService, HighlightService],
})
export class HighlightServiceModule {}
