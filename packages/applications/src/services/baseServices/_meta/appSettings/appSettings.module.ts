import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppSettingsService } from './appSettings.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { IAppSettingsService } from './IAppSettingsService';

@Global()
@Module({})
export class AppSettingsModule {
  static forRoot(): DynamicModule {
    return {
      module: AppSettingsModule,
      imports: [CoreDatabaseModule],
      providers: [
        {
          provide: IAppSettingsService,
          useClass: AppSettingsService,
        },
      ],
      exports: [IAppSettingsService],
    };
  }
}
