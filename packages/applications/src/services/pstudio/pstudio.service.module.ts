import { Module } from '@nestjs/common';
import { PrismaStudioService } from './pstudio.service';
import { IPrismaStudioService } from './IPrismaStudioService';

@Module({
  providers: [
    {
      provide: IPrismaStudioService,
      useClass: PrismaStudioService,
    },
  ],
  exports: [IPrismaStudioService],
})
export class PrismaStudioServiceModule {}
