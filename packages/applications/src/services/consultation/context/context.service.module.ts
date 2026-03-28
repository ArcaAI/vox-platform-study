import { Module } from '@nestjs/common';
import { ContextService } from './context.service';
import { IContextService } from './IContextService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IContextService,
      useClass: ContextService,
    },
    ContextService,
  ],
  exports: [IContextService, ContextService],
})
export class ContextServiceModule {}
