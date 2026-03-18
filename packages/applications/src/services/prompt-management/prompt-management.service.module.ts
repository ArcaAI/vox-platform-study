import { Module } from '@nestjs/common';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: IPromptManagementService,
            useClass: PromptManagementService,
        },
        PromptManagementService,
    ],
    exports: [IPromptManagementService, PromptManagementService],
})
export class PromptManagementServiceModule {}
