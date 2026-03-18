import { AutoClassMapper, UserEntity } from '@arcaai/domains';
import { UserResponse, PaginatedUserResponse } from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class UserDtoMapper {
    static ToResponse(entity: UserEntity): UserResponse {
        return AutoClassMapper(entity, UserResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<UserEntity>): PaginatedUserResponse {
        return new PaginatedUserResponse({
            page,
            limit,
            count,
            data: data.map((user) => this.ToResponse(user))
        });
    }
}
