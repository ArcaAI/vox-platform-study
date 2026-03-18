import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { DnaWritingStyleService } from './dna-writing-style.service';
import { IDnaWritingStyleService } from './IDnaWritingStyleService';
import { DnaWritingStyleProcessor } from './dna-writing-style.processor';
import { DnaRegenerationScheduler } from './dna-regeneration.scheduler';
import { CommonServiceModule } from '../baseServices';
import { PromptManagementServiceModule } from '../prompt-management/prompt-management.service.module';
import { ConsultationJobServiceModule } from '../consultation/jobs/consultation-job.service.module';

@Module({
    imports: [
        CommonServiceModule,
        CoreDatabaseModule,
        HttpModule,
        ConfigModule,
        PromptManagementServiceModule,
        ConsultationJobServiceModule,
        BullModule.registerQueue({ name: JobQueue.GenerateDnaReport }),
    ],
    providers: [
        {
            provide: IDnaWritingStyleService,
            useClass: DnaWritingStyleService,
        },
        DnaWritingStyleService,
        DnaWritingStyleProcessor,
        DnaRegenerationScheduler,
    ],
    exports: [
        IDnaWritingStyleService,
        DnaWritingStyleService,
        DnaRegenerationScheduler,
        BullModule,
    ],
})
export class DnaWritingStyleServiceModule {}
