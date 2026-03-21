import { Module } from '@nestjs/common';
import { GlobalSettingService } from './globalSetting.service';
import { IGlobalSettingService } from './IGlobalSettingService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IGlobalSettingService,
            useClass: GlobalSettingService
        }
    ],
    exports: [IGlobalSettingService]
})
export class GlobalSettingServiceModule {}
