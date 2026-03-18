import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PipelineService } from './pipeline.service';

@Module({
    imports: [
        CoreDatabaseModule,
        EventEmitterModule,
        ClsModule,
    ],
    providers: [PipelineService],
    exports: [PipelineService],
})
export class PipelineServiceModule {}
