import { ApiProperty } from '@nestjs/swagger';
import { ConsultationResponse } from './consultation.response';

export class PaginatedConsultationResponse {
    @ApiProperty({ type: [ConsultationResponse] })
    data: ConsultationResponse[];

    @ApiProperty()
    count: number;

    @ApiProperty()
    page: number;

    @ApiProperty()
    limit: number;
}
