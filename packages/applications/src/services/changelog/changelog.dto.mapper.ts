import { ChangelogEntryEntity } from '@arcaai/domains';
import { FetchResponse } from '../../common';
import { ChangelogEntryResponse, PaginatedChangelogEntryResponse } from './dto';

export class ChangelogDtoMapper {
  static toResponse(entity: ChangelogEntryEntity, acknowledged?: boolean): ChangelogEntryResponse {
    return {
      id: entity.id,
      platformVersion: entity.platformVersion,
      title: entity.title,
      summary: entity.summary,
      body: entity.body,
      severity: entity.severity,
      audience: entity.audience,
      publishStatus: entity.publishStatus,
      publishedAt: entity.publishedAt ? entity.publishedAt.toISOString() : null,
      ...(acknowledged === undefined ? {} : { acknowledged }),
      version: entity.version,
    };
  }

  static ToPaginatedResponse(
    { page, limit, count, data }: FetchResponse<ChangelogEntryEntity>,
    acknowledgedIds?: ReadonlySet<string>,
  ): PaginatedChangelogEntryResponse {
    return new PaginatedChangelogEntryResponse({
      page,
      limit,
      count,
      data: data.map((entry) => this.toResponse(entry, acknowledgedIds ? acknowledgedIds.has(entry.id) : undefined)),
    });
  }
}
