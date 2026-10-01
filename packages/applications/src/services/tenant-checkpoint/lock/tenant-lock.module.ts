import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { RedisCacheModule } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { ITenantLockService } from '../contracts';
import { TenantLockService } from './tenant-lock.service';

@Module({
  imports: [CoreDatabaseModule, RedisCacheModule.register()],
  providers: [RedisSubscriberService, { provide: ITenantLockService, useClass: TenantLockService }],
  exports: [ITenantLockService],
})
export class TenantLockModule {}
