import { Module } from '@nestjs/common';
import { ConfigModule } from '../../baseServices/_meta/config';
import { TextStreamConsumerService } from './text-stream-consumer.service';

/**
 * SMR Stream Consumer Module
 *
 * Provides direct Redis Streams consumption for SMR task chunks.
 * Bypasses the Python SSE proxy for lower-latency streaming.
 *
 * Imports:
 * - ConfigModule: Access to Redis config via IConfigService
 *
 * Providers/Exports:
 * - TextStreamConsumerService: XREAD-based chunk subscription
 */
@Module({
  imports: [ConfigModule],
  providers: [TextStreamConsumerService],
  exports: [TextStreamConsumerService],
})
export class TextStreamConsumerModule {}
