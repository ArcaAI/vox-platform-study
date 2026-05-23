import { Global, Module } from '@nestjs/common';
import { RedisCacheModule } from '@arcaai/applications';
import { StreamTicketService } from './stream-ticket.service';

/**
 * StreamTicketModule (TASK-263 W0-1)
 *
 * Provides the `StreamTicketService` globally so that:
 *   - `AuthController` can call `issueTicket()` from `POST /auth/stream-ticket`.
 *   - `JwtAuthGuard` (registered globally in `JwtAuthGuardModule`) can call
 *     `consumeTicket()` when the request carries `?ticket=…`.
 *
 * Marked `@Global` so consumers do not need to import this module explicitly.
 */
@Global()
@Module({
  imports: [RedisCacheModule.register()],
  providers: [StreamTicketService],
  exports: [StreamTicketService],
})
export class StreamTicketModule {}
