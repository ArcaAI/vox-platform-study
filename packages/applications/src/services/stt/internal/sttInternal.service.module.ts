import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { SttInternalService } from './sttInternal.service';

@Module({
    imports: [
        CoreDatabaseModule,
        EventEmitterModule,
        ClsModule,
    ],
    providers: [SttInternalService],
    exports: [SttInternalService],
})
export class SttInternalServiceModule {}
