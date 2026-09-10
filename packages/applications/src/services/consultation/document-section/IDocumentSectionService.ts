import { DocumentSectionResponse, UpdateDocumentSectionRequest } from './dto';

export abstract class IDocumentSectionService {
  abstract listSections(consultationId: string, documentKey: string): Promise<DocumentSectionResponse[]>;
  abstract listAllSections(consultationId: string): Promise<DocumentSectionResponse[]>;
  abstract getSection(consultationId: string, documentKey: string, sectionKey: string): Promise<DocumentSectionResponse>;
  abstract updateSectionContent(
    consultationId: string,
    documentKey: string,
    sectionKey: string,
    request: UpdateDocumentSectionRequest,
  ): Promise<DocumentSectionResponse>;
}
