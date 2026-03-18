import { Module } from '@nestjs/common';
import { DepartmentServiceModule } from '@arcaai/applications';
import { DepartmentController } from './department.controller';

@Module({
    imports: [DepartmentServiceModule],
    controllers: [DepartmentController],
})
export class DepartmentModule {}
