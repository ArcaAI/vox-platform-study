import { Module } from '@nestjs/common';
import { TenantServiceModule, TenantFrontendConfigServiceModule } from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantController } from './my-tenant.controller';

@Module({
  imports: [TenantServiceModule, TenantFrontendConfigServiceModule],
  controllers: [TenantController, MyTenantController],
})
export class TenantModule {}
