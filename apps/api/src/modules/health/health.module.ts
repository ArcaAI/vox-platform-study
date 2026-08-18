import { BuildInfoService, HealthCheckServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AdminHealthServicesController } from './admin-health-services.controller';
import { ApiHealthController } from './health.controller';

@Module({
  imports: [HealthCheckServiceModule, HttpModule],
  // Two controllers, one module: the public k8s probes (`health`) and the
  // admin-plane downstream probes (`admin/health/services`) split by TASK-759
  // but still share this module's `HttpModule` + config wiring.
  controllers: [ApiHealthController, AdminHealthServicesController],
  // `BuildInfoService` is a plain class (no `@Injectable()` — its constructor
  // takes a path + test seams, not injectable services), so it is provided
  // via factory rather than relying on Nest's constructor-param reflection.
  // Read once at boot and cached.
  providers: [{ provide: BuildInfoService, useFactory: () => new BuildInfoService() }],
})
export class HealthModule {}
