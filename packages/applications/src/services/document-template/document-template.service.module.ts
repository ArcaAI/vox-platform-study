import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IDocumentTemplateService } from './IDocumentTemplateService';
import { DocumentTemplateService } from './document-template.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    DocumentTemplateService,
    // useExisting, not useClass — useClass would construct a SECOND instance
    // instead of aliasing the one above (the ConsultationContextSchemaServiceModule
    // precedent).
    { provide: IDocumentTemplateService, useExisting: DocumentTemplateService },
  ],
  exports: [IDocumentTemplateService, DocumentTemplateService],
})
export class DocumentTemplateServiceModule {}
