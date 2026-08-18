import { Module } from '@nestjs/common';
import { ServiceAccountServiceModule } from '@arcaai/applications';
import { ServiceAccountController } from './service-account.controller';
import { ServiceAccountTokenController } from './service-account-token.controller';
import { ServiceAccountTokenGuard } from './service-account-token.guard';

@Module({
  imports: [ServiceAccountServiceModule],
  controllers: [ServiceAccountController, ServiceAccountTokenController],
  providers: [ServiceAccountTokenGuard],
})
export class ServiceAccountModule {}
