import { AutoClassMapper, UserRoleAssignmentEntity } from '@arcaai/domains';
import {
    UserRoleAssignmentResponse,
    PaginatedUserRoleAssignmentResponse
} from './dto';
import { FetchResponse } from '../../../common';

// TODO: Implement this

export class UserRoleAssignmentDtoMapper {
    static ToResponse(
        entity: UserRoleAssignmentEntity
    ): UserRoleAssignmentResponse {
        const response = AutoClassMapper(entity, UserRoleAssignmentResponse);
        if (!response.roleName && entity.Roles?.length) {
            response.roleName = entity.Roles[0].name;
        }
        return response;
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data
    }: FetchResponse<UserRoleAssignmentEntity>): PaginatedUserRoleAssignmentResponse {
        return new PaginatedUserRoleAssignmentResponse({
            page,
            limit,
            count,
            data: data.map((userRoleAssignment) =>
                this.ToResponse(userRoleAssignment)
            )
        });
    }
}
