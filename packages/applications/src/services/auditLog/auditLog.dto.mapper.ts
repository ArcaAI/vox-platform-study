import { AuditLogEntity, AutoClassMapper } from '@arcaai/domains';
import { AuditLogResponse, PaginatedAuditLogResponse } from './dto';
import { FetchResponse } from '../../common';

export class AuditLogDtoMapper {
    static ToResponse(entity: AuditLogEntity): AuditLogResponse {
        return AutoClassMapper(entity, AuditLogResponse);
    }

    static ToPaginatedResponse({
        page,
        limit,
        count,
        data,
    }: FetchResponse<AuditLogEntity>): PaginatedAuditLogResponse {
        return new PaginatedAuditLogResponse({
            page,
            limit,
            count,
            data: data.map((contact) => this.ToResponse(contact)),
        });
    }
}
