import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { HarnessGatewayService } from './harness-gateway.service';

/**
 * HarnessGatewayService DI module. Leaf module:
 * only needs HttpModule + ConfigModule (SecretsService is provided globally by
 * the @Global SecretsModule). Kept separate from the inbound harness-internal
 * module so the BullMQ-heavy ConsultationJobServiceModule and SummaryServiceModule
 * can import just the outbound gateway without a circular dependency.
 */
@Module({
  imports: [ConfigModule, HttpModule],
  providers: [HarnessGatewayService],
  exports: [HarnessGatewayService],
})
export class HarnessGatewayServiceModule {}
