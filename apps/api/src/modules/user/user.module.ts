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
  UserPasswordServiceModule,
} from '@arcaai/applications';
import { UserController } from './user.controller';
import { UserPreferencesController } from './controllers/user-preferences.controller';
import { UserRolesController } from './controllers/user-roles.controller';
import { UserSettingsController } from './controllers/user-settings.controller';
import { UserDepartmentsController } from './controllers/user-departments.controller';
import { UserDepartmentsMeController } from './controllers/user-departments-me.controller';
import { PasswordResetController } from './controllers/password-reset.controller';
// Public self-service forgot-password (mounted under auth/).
import { ForgotPasswordController } from './controllers/forgot-password.controller';
import { UserExportService } from './user-export.service';

@Module({
  imports: [
    UserServiceModule,
    ApiKeyServiceModule,
    UserPreferencesServiceModule,
    UserSettingsServiceModule,
    UserRoleAssignmentServiceModule,
    // Admin user profile (preferredPromptTemplateId) + department assignments
    // + read-only enrolled voice profiles for the user-detail dialog.
    UserProfileServiceModule,
    UserDepartmentServiceModule,
    VoiceProfileServiceModule,
    // UserSettingsController uses PipelineService to validate
    // the `arcaai-sdk:selectedPipelineId` value against the caller's tenant.
    PipelineServiceModule,
    // Admin reset-password + public completion.
    UserPasswordServiceModule,
  ],
  controllers: [
    UserController,
    UserPreferencesController,
    UserRolesController,
    UserSettingsController,
    UserDepartmentsController,
    UserDepartmentsMeController,
    PasswordResetController,
    ForgotPasswordController,
  ],
  // Export serialization (exceljs/pdfkit) consumed by UserController.
  providers: [UserExportService],
})
export class UserModule {}
