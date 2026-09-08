import { Module } from '@nestjs/common';
import { AgentPromotionServiceModule } from '@arcaai/applications';
import { AgentPromoteToSystemController } from './agent-promote-to-system.controller';
import { AgentPromotionController } from './agent-promotion.controller';

@Module({
  imports: [AgentPromotionServiceModule],
  controllers: [AgentPromotionController, AgentPromoteToSystemController],
})
export class AgentPromotionModule {}
