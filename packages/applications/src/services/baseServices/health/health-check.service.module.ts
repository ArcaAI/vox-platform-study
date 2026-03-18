import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';

import { HealthCheckService } from './health-check.service';
import { IHealthCheckService } from './IHealthCheckService';

/**
 * Provides IHealthCheckService (Terminus-based) for injection.
 *
 * Does NOT register its own controller — the API gateway's
 * ApiHealthController owns the /health routes and follows the
 * HOPE standardized health contract.
 */
@Module({
    imports: [TerminusModule, HttpModule],
    providers: [
        {
            provide: IHealthCheckService,
            useClass: HealthCheckService,
        },
    ],
    exports: [IHealthCheckService],
})
export class HealthCheckServiceModule {}
