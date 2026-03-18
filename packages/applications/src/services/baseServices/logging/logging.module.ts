import { Global, Module } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { ILoggingService } from './ILoggingService';

@Global()
@Module({
    providers: [
        LoggingService,
        {
            provide: ILoggingService,
            useExisting: LoggingService,
        },
    ],
    exports: [LoggingService, ILoggingService],
})
export class LoggingServiceModule {}
