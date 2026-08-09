import { Module } from '@nestjs/common';
import { ServiceReleaseServiceModule } from '@arcaai/applications';
import { ServiceReleaseInternalController } from './service-release-internal.controller';
import { ServiceReleaseAdminController } from './service-release-admin.controller';
import { ServiceReleaseTokenGuard } from './service-release-token.guard';

@Module({
  imports: [ServiceReleaseServiceModule],
  controllers: [ServiceReleaseInternalController, ServiceReleaseAdminController],
  // Applied via `@UseGuards` on the internal controller, but provided here so
  // Nest can inject `SecretsService` into it.
  providers: [ServiceReleaseTokenGuard],
})
export class ServiceReleaseModule {}
