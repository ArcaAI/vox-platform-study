import { Global, Module } from '@nestjs/common';
import { GracefulShutdownService, IGracefulShutdownService } from './graceful-shutdown.service';

/**
 * GracefulShutdownModule
 *
 * Global module that provides graceful shutdown coordination across the application.
 * Being a global module, it can be injected anywhere without explicit imports.
 */
@Global()
@Module({
    providers: [
        {
            provide: IGracefulShutdownService,
            useClass: GracefulShutdownService,
        },
        GracefulShutdownService,
    ],
    exports: [IGracefulShutdownService, GracefulShutdownService],
})
export class GracefulShutdownModule {}
