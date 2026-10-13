import { DocumentSectionResponse, UpdateDocumentSectionRequest } from './dto';

export abstract class IDocumentSectionService {
  /** `encounterSeq` absent ⇒ the consultation's CURRENT encounter. */
  abstract listSections(consultationId: string, documentKey: string, encounterSeq?: number): Promise<DocumentSectionResponse[]>;
  /** `encounterSeq` absent ⇒ the consultation's CURRENT encounter. */
  abstract listAllSections(consultationId: string, encounterSeq?: number): Promise<DocumentSectionResponse[]>;
  abstract getSection(consultationId: string, documentKey: string, sectionKey: string): Promise<DocumentSectionResponse>;
  abstract updateSectionContent(
    consultationId: string,
    documentKey: string,
    sectionKey: string,
    request: UpdateDocumentSectionRequest,
  ): Promise<DocumentSectionResponse>;
}
