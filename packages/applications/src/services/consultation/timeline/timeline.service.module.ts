import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { TimelineService } from './timeline.service';

@Module({
    imports: [CoreDatabaseModule],
    providers: [TimelineService],
    exports: [TimelineService],
})
export class TimelineServiceModule {}
