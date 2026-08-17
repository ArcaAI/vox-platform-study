import {
  AcknowledgeChangelogRequest,
  ChangelogEntryResponse,
  CreateChangelogEntryRequest,
  ListChangelogQuery,
  PaginatedChangelogEntryResponse,
  UpdateChangelogEntryRequest,
} from './dto';

export const IChangelogService = Symbol('IChangelogService');

export interface IChangelogService {
  /** Audience-filtered, paginated, newest published first. Super Admins also see DRAFT. */
  list(query: ListChangelogQuery): Promise<PaginatedChangelogEntryResponse>;
  /** The one-time "What's New" popup's data source. Capped at 3; empty while impersonating. */
  listUnseen(): Promise<ChangelogEntryResponse[]>;
  /** Idempotent. */
  acknowledge(entryIds: AcknowledgeChangelogRequest['entryIds']): Promise<void>;
  create(dto: CreateChangelogEntryRequest): Promise<ChangelogEntryResponse>;
  update(id: string, dto: UpdateChangelogEntryRequest): Promise<ChangelogEntryResponse>;
  publish(id: string, expectedVersion?: number): Promise<ChangelogEntryResponse>;
}
