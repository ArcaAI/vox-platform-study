import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IConsultationContextSchemaService } from './IConsultationContextSchemaService';
import { ConsultationContextSchemaService } from './consultation-context-schema.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    ConsultationContextSchemaService,
    // useExisting, not useClass — useClass would construct a SECOND instance
    // instead of aliasing the one above (the TenantAllowedOriginServiceModule
    // precedent).
    { provide: IConsultationContextSchemaService, useExisting: ConsultationContextSchemaService },
  ],
  exports: [IConsultationContextSchemaService, ConsultationContextSchemaService],
})
export class ConsultationContextSchemaServiceModule {}
