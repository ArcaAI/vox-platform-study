import { CreateHighlightRequest, HighlightResponse } from './dto';

export abstract class IHighlightService {
  abstract createHighlight(consultationId: string, request: CreateHighlightRequest): Promise<HighlightResponse>;
  abstract getHighlights(consultationId: string): Promise<HighlightResponse[]>;
  abstract deleteHighlight(consultationId: string, highlightId: string): Promise<void>;
}
