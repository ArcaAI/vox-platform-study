import { AutoClassMapper, UserSettingsEntity } from '@arcaai/domains';
import { UserSettingsResponse, PaginatedUserSettingsResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class UserSettingsDtoMapper {
    static ToResponse(entity: UserSettingsEntity): UserSettingsResponse {
        return AutoClassMapper(entity, UserSettingsResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<UserSettingsEntity>): PaginatedUserSettingsResponse {
        return new PaginatedUserSettingsResponse({
            page,
            limit,
            count,
            data: data.map((userSettings) => this.ToResponse(userSettings))
        });
    }
}
