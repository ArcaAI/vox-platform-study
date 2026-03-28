import { AutoClassMapper, GlobalSettingEntity } from '@arcaai/domains';
import { GlobalSettingResponse, PaginatedGlobalSettingResponse } from './dto';
import { FetchResponse } from '../../common';

// TODO: Implement this

export class GlobalSettingDtoMapper {
  static ToResponse(entity: GlobalSettingEntity): GlobalSettingResponse {
    return AutoClassMapper(entity, GlobalSettingResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<GlobalSettingEntity>): PaginatedGlobalSettingResponse {
    return new PaginatedGlobalSettingResponse({
      page,
      limit,
      count,
      data: data.map((globalSetting) => this.ToResponse(globalSetting)),
    });
  }
}
