import { ConsentServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { ConsentGrantController } from './consent.controller';

/** Mounts the `/admin/consent-grants*` surface (TASK-712, consent-abac). */
@Module({
  imports: [ConsentServiceModule],
  controllers: [ConsentGrantController],
})
export class ConsentModule {}
