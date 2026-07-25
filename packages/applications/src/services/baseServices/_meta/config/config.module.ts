import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, IConfigService } from './IConfigService';
import { ConfigService } from './config.service';

// Define a proper interface for config options
export interface ConfigModuleOptions {
  envFilePath?: string;
  initialValues?: Partial<AppConfig>;
}

@Global()
@Module({})
export class ConfigModule {
  static forRoot(options: ConfigModuleOptions = {}): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        {
          provide: 'CONFIG_OPTIONS',
          useValue: options,
        },
        {
          provide: IConfigService,
          useFactory: async (configOptions: ConfigModuleOptions) => {
            const configService = new ConfigService(configOptions);
            await configService.loadConfig();
            return configService;
          },
          inject: ['CONFIG_OPTIONS'],
        },
      ],
      exports: [IConfigService],
    };
  }
}
