import { Module } from '@nestjs/common';
import { ConsultationContextSchemaServiceModule } from '@arcaai/applications';
import { ConsultationContextSchemaAdminController, MyTenantContextSchemaController } from './consultation-context-schema.controller';
import { MyTenantContextSchemaRedirectShimController } from './consultation-context-schema-redirect.shim.controller';

@Module({
  imports: [ConsultationContextSchemaServiceModule],
  controllers: [ConsultationContextSchemaAdminController, MyTenantContextSchemaController, MyTenantContextSchemaRedirectShimController],
})
export class ConsultationContextSchemaModule {}
