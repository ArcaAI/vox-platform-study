import { Module } from '@nestjs/common';
import { StorageAccessKeyService } from './storage-access-key.service';
import { IStorageAccessKeyService } from './IStorageAccessKeyService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// Register the service ONLY via the interface token.
// Previously the bare `StorageAccessKeyService` was also listed, which made
// NestJS instantiate the service twice. Consumers inject `IStorageAccessKeyService`.
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IStorageAccessKeyService,
      useClass: StorageAccessKeyService,
    },
  ],
  exports: [IStorageAccessKeyService],
})
export class StorageAccessKeyServiceModule {}
