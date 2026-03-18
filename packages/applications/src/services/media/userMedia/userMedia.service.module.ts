import { Module } from '@nestjs/common';
import { UserMediaService } from './userMedia.service';
import { IUserMediaService } from './IUserMediaService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IUserMediaService,
            useClass: UserMediaService
        }
    ],
    exports: [IUserMediaService]
})
export class UserMediaServiceModule {}
