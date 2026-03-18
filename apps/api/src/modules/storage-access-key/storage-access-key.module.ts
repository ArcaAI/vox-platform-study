import { StorageAccessKeyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { StorageAccessKeyController } from './storage-access-key.controller';

@Module({
    imports: [StorageAccessKeyServiceModule],
    controllers: [StorageAccessKeyController],
})
export class StorageAccessKeyModule {}
