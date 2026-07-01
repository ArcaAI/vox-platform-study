import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { IMediaService } from './IMediaService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';

// TODO: Implement this

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    {
      provide: IMediaService,
      useClass: MediaService,
    },
  ],
  exports: [IMediaService],
})
export class MediaServiceModule {}
