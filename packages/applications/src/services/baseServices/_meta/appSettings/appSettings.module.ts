import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppSettingsService } from './appSettings.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { IAppSettingsService } from './IAppSettingsService';
import { RedisCacheModule } from '../../redis';
import { RedisSubscriberService } from '../../../stt/realtime/redisSubscriber.service';

@Global()
@Module({})
export class AppSettingsModule {
  // Memoize the DynamicModule. `forRoot()` is called from more
  // than one place (CommonServiceModule directly + S3ServiceModule.forRoot()).
  // Each call used to return a NEW object, which Nest treats as a distinct
  // module: two AppSettingsService instances booted, both registered the
  // 'updateCacheAppSettings' cron under the same name, the second registration
  // deleted the first's job — so the instance most consumers injected never
  // refreshed its settings cache after boot. Returning the same object makes
  // Nest dedupe the module and guarantees a single cached instance + cron.
  //
  // RedisCacheModule (publish) + a dedicated RedisSubscriberService instance
  // (subscribe) back the F-007 cross-instance invalidation channel. Both fail
  // open at the service layer when Redis is absent/unreachable, so this
  // module still boots without Redis (cron-only convergence).
  private static readonly dynamicModule: DynamicModule = {
    module: AppSettingsModule,
    imports: [CoreDatabaseModule, RedisCacheModule.register()],
    providers: [
      RedisSubscriberService,
      {
        provide: IAppSettingsService,
        useClass: AppSettingsService,
      },
    ],
    exports: [IAppSettingsService],
  };

  static forRoot(): DynamicModule {
    return AppSettingsModule.dynamicModule;
  }
}
