import { Module } from '@nestjs/common';
import { UserSettingsService } from './userSettings.service';
import { IUserSettingsService } from './IUserSettingsService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IUserSettingsService,
            useClass: UserSettingsService
        }
    ],
    exports: [IUserSettingsService]
})
export class UserSettingsServiceModule {}
