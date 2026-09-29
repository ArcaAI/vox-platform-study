import { Module } from '@nestjs/common';
import { ConsultationContextSchemaServiceModule } from '@arcaai/applications';
import { ConsultationContextSchemaAdminController, MyTenantContextSchemaController } from './consultation-context-schema.controller';

@Module({
  imports: [ConsultationContextSchemaServiceModule],
  controllers: [ConsultationContextSchemaAdminController, MyTenantContextSchemaController],
})
export class ConsultationContextSchemaModule {}
