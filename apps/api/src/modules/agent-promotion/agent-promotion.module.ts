import { Module } from '@nestjs/common';
import { AgentPromotionServiceModule } from '@arcaai/applications';
import { AgentPromotionController } from './agent-promotion.controller';

@Module({
  imports: [AgentPromotionServiceModule],
  controllers: [AgentPromotionController],
})
export class AgentPromotionModule {}
