import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { IUserService } from './IUserService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IUserService,
            useClass: UserService
        }
    ],
    exports: [IUserService]
})
export class UserServiceModule {}
