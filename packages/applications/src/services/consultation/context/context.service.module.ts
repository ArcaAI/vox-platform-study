import { Module } from '@nestjs/common';
import { ContextService } from './context.service';
import { IContextService } from './IContextService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    ContextService,
    {
      provide: IContextService,
      // useExisting, not useClass — useClass would construct a second
      // ContextService instance instead of aliasing the one above. It uses
      // Map/Set only as local variables inside method bodies, not instance
      // fields, so the duplicate was harmless, but aliasing is free.
      useExisting: ContextService,
    },
  ],
  exports: [IContextService, ContextService],
})
export class ContextServiceModule {}
