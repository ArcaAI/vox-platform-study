import { Module } from '@nestjs/common';
import { DocumentTemplateServiceModule } from '@arcaai/applications';
import { DocumentTemplateAdminController, MyTenantDocumentTemplateController } from './document-template.controller';

@Module({
  imports: [DocumentTemplateServiceModule],
  controllers: [DocumentTemplateAdminController, MyTenantDocumentTemplateController],
})
export class DocumentTemplateModule {}
