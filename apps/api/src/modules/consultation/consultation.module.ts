import { Module } from '@nestjs/common';
import {
    ConsultationServiceModule,
    ContextServiceModule,
    ConsultationJobServiceModule,
    SummaryServiceModule,
    TimelineServiceModule,
    ChainSummaryServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConsultationController } from './consultation.controller';

@Module({
    imports: [
        ConsultationServiceModule,
        ContextServiceModule,
        ConsultationJobServiceModule,
        SummaryServiceModule,
        TimelineServiceModule,
        ChainSummaryServiceModule,
        CoreDatabaseModule,
    ],
    controllers: [ConsultationController],
})
export class ConsultationModule {}
