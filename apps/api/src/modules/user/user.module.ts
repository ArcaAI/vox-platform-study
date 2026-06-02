import { Module } from '@nestjs/common';
import {
  UserServiceModule,
  ApiKeyServiceModule,
  UserPreferencesServiceModule,
  UserSettingsServiceModule,
  UserRoleAssignmentServiceModule,
  UserProfileServiceModule,
  UserDepartmentServiceModule,
  VoiceProfileServiceModule,
  PipelineServiceModule,
} from '@arcaai/applications';
import { UserController } from './user.controller';
import { UserPreferencesController } from './controllers/user-preferences.controller';
import { UserRolesController } from './controllers/user-roles.controller';
import { UserSettingsController } from './controllers/user-settings.controller';
import { UserDepartmentsController } from './controllers/user-departments.controller';

@Module({
  imports: [
    UserServiceModule,
    ApiKeyServiceModule,
    UserPreferencesServiceModule,
    UserSettingsServiceModule,
    UserRoleAssignmentServiceModule,
    // TASK-328 A1–A3 — admin user profile (preferredPromptTemplateId) + department assignments
    // + read-only enrolled voice profiles for the user-detail dialog.
    UserProfileServiceModule,
    UserDepartmentServiceModule,
    VoiceProfileServiceModule,
    // TASK-298 D-5 — UserSettingsController uses PipelineService to validate
    // the `arcaai-sdk:selectedPipelineId` value against the caller's tenant.
    PipelineServiceModule,
  ],
  controllers: [UserController, UserPreferencesController, UserRolesController, UserSettingsController, UserDepartmentsController],
})
export class UserModule {}
