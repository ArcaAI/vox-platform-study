import { SttInternalServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { SttInternalController } from './stt-internal.controller';

@Module({
  imports: [SttInternalServiceModule],
  controllers: [SttInternalController],
})
export class InternalModule {}
