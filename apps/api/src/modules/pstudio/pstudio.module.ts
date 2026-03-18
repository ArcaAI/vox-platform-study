import { PrismaStudioServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { PrismaStudioController } from './pstudio.controller';

@Module({
    imports: [PrismaStudioServiceModule],
    controllers: [PrismaStudioController],
})
export class PrismaStudioModule {}
