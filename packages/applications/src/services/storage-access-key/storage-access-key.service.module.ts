import { Module } from '@nestjs/common';
import { StorageAccessKeyService } from './storage-access-key.service';
import { IStorageAccessKeyService } from './IStorageAccessKeyService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// TASK-318 W3 (F-4b) — register the service ONLY via the interface token.
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
