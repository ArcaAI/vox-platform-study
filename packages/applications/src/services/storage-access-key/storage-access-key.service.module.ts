import { Module } from '@nestjs/common';
import { StorageAccessKeyService } from './storage-access-key.service';
import { IStorageAccessKeyService } from './IStorageAccessKeyService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IStorageAccessKeyService,
      useClass: StorageAccessKeyService,
    },
    StorageAccessKeyService,
  ],
  exports: [IStorageAccessKeyService, StorageAccessKeyService],
})
export class StorageAccessKeyServiceModule {}
