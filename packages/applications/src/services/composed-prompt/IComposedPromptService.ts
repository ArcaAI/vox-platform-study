import type {
  ComposedPromptDetailResponse,
  ComposedPromptPageResponse,
  ListComposedPromptsQuery,
  RecordComposedPromptRequest,
} from './dto/composed-prompt.dto';

export const IComposedPromptService = Symbol('IComposedPromptService');

export interface IComposedPromptService {
  /** Accept the harness's record of a call (`POST internal/composed-prompts`); written in the background. */
  acceptInternal(dto: RecordComposedPromptRequest, tenantId: string): void;
  /** One tenant's records, METADATA only, newest first. Audited. */
  list(query: ListComposedPromptsQuery): Promise<ComposedPromptPageResponse>;
  /** One record, DECRYPTED. Audited; another tenant's id is a 404. */
  getDecrypted(id: string): Promise<ComposedPromptDetailResponse>;
}
