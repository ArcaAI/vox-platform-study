import { BuildInfoService, HealthCheckServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ApiHealthController } from './health.controller';

@Module({
  imports: [HealthCheckServiceModule, HttpModule],
  controllers: [ApiHealthController],
  // `BuildInfoService` is a plain class (no `@Injectable()` — its constructor
  // takes a path + test seams, not injectable services), so it is provided
  // via factory rather than relying on Nest's constructor-param reflection.
  // Read once at boot and cached.
  providers: [{ provide: BuildInfoService, useFactory: () => new BuildInfoService() }],
})
export class HealthModule {}
