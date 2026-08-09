import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ServiceReleaseService } from './serviceRelease.service';
import { IServiceReleaseService } from './IServiceReleaseService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ServiceReleaseService, { provide: IServiceReleaseService, useExisting: ServiceReleaseService }],
  exports: [IServiceReleaseService, ServiceReleaseService],
})
export class ServiceReleaseServiceModule {}
