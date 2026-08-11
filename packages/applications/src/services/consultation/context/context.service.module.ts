import { Module } from '@nestjs/common';
import { ContextService } from './context.service';
import { IContextService } from './IContextService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ConsultationContextSchemaServiceModule } from '../../consultation-context-schema';

@Module({
  // TASK-658 — `ConsultationContextSchemaServiceModule` supplies the OPTIONAL
  // `IConsultationContextSchemaService` that `ContextService` uses to
  // validate a write naming a `kindKey`. The dependency is one-way (the
  // schema plane knows nothing about `ContextService`), so there is no
  // circular-module hazard here.
  imports: [CommonServiceModule, CoreDatabaseModule, ConsultationContextSchemaServiceModule],
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
