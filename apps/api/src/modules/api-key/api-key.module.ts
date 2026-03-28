import { ApiKeyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';

@Module({
  imports: [ApiKeyServiceModule],
  controllers: [ApiKeyController],
})
export class ApiKeyModule {}
