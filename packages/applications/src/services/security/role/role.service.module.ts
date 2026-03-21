import { Module } from '@nestjs/common';
import { RoleService } from './role.service';
import { IRoleService } from './IRoleService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IRoleService,
            useClass: RoleService
        }
    ],
    exports: [IRoleService]
})
export class RoleServiceModule {}
