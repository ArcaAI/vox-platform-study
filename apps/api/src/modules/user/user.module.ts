import { Module } from '@nestjs/common';
import {
  UserServiceModule,
  ApiKeyServiceModule,
  UserPreferencesServiceModule,
  UserSettingsServiceModule,
  UserRoleAssignmentServiceModule,
  PipelineServiceModule,
} from '@arcaai/applications';
import { UserController } from './user.controller';
import { UserPreferencesController } from './controllers/user-preferences.controller';
import { UserRolesController } from './controllers/user-roles.controller';
import { UserSettingsController } from './controllers/user-settings.controller';

@Module({
  imports: [
    UserServiceModule,
    ApiKeyServiceModule,
    UserPreferencesServiceModule,
    UserSettingsServiceModule,
    UserRoleAssignmentServiceModule,
    // TASK-298 D-5 — UserSettingsController uses PipelineService to validate
    // the `arcaai-sdk:selectedPipelineId` value against the caller's tenant.
    PipelineServiceModule,
  ],
  controllers: [UserController, UserPreferencesController, UserRolesController, UserSettingsController],
})
export class UserModule {}
