import { TenantFrontendConfigServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { TenantFrontendConfigAdminController } from './tenant-frontend-config-admin.controller';

/**
 * Admin frontend-pipeline-config feature module (TASK-328 A6). Imports only the
 * application service module; tenant scoping + OCC live in the service layer.
 */
@Module({
  imports: [TenantFrontendConfigServiceModule],
  controllers: [TenantFrontendConfigAdminController],
})
export class TenantFrontendConfigModule {}
