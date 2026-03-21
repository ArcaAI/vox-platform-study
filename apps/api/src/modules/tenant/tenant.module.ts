import { Module } from '@nestjs/common';
import { TenantServiceModule } from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantController } from './my-tenant.controller';

@Module({
    imports: [TenantServiceModule],
    controllers: [TenantController, MyTenantController]
})
export class TenantModule {}
