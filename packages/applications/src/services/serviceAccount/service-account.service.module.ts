import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ServiceAccountService } from './service-account.service';
import { IServiceAccountService } from './IServiceAccountService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ServiceAccountService, { provide: IServiceAccountService, useExisting: ServiceAccountService }],
  exports: [IServiceAccountService, ServiceAccountService],
})
export class ServiceAccountServiceModule {}
