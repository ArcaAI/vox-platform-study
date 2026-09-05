import { GuardrailAvailabilityServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { GuardrailAvailabilityController } from './guardrail-availability.controller';

@Module({
  imports: [GuardrailAvailabilityServiceModule],
  controllers: [GuardrailAvailabilityController],
})
export class GuardrailAvailabilityModule {}
