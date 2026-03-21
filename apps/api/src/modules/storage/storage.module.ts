import { S3ServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';

@Module({
    imports: [S3ServiceModule],
    controllers: [StorageController],
})
export class StorageModule {}
