import { Module } from '@nestjs/common';
import { TagService } from './tag.service';
import { ITagService } from './ITagService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: ITagService,
            useClass: TagService
        }
    ],
    exports: [ITagService]
})
export class TagServiceModule {}
