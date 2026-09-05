import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { GuardrailAvailabilityService } from './guardrail-availability.service';
import { IGuardrailAvailabilityService } from './IGuardrailAvailabilityService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [{ provide: IGuardrailAvailabilityService, useClass: GuardrailAvailabilityService }],
  exports: [IGuardrailAvailabilityService],
})
export class GuardrailAvailabilityServiceModule {}
