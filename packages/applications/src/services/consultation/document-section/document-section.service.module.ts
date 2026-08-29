import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { DocumentSectionService } from './document-section.service';
import { IDocumentSectionService } from './IDocumentSectionService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    DocumentSectionService,
    {
      provide: IDocumentSectionService,
      // useExisting, not useClass: the service memoizes its DocumentSectionStore,
      // and a second instance would mean two stores over one table.
      useExisting: DocumentSectionService,
    },
  ],
  exports: [IDocumentSectionService, DocumentSectionService],
})
export class DocumentSectionServiceModule {}
