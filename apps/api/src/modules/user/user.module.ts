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
  // TASK-388 #8 — reset-password service (temp password + emailed link + completion).
  UserPasswordServiceModule,
} from '@arcaai/applications';
import { UserController } from './user.controller';
import { UserPreferencesController } from './controllers/user-preferences.controller';
import { UserRolesController } from './controllers/user-roles.controller';
import { UserSettingsController } from './controllers/user-settings.controller';
import { UserDepartmentsController } from './controllers/user-departments.controller';
import { PasswordResetController } from './controllers/password-reset.controller';
// TASK-400 — public self-service forgot-password (mounted under auth/).
import { ForgotPasswordController } from './controllers/forgot-password.controller';
import { UserExportService } from './user-export.service';

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
    // TASK-388 #8 — admin reset-password + public completion.
    UserPasswordServiceModule,
  ],
  controllers: [
    UserController,
    UserPreferencesController,
    UserRolesController,
    UserSettingsController,
    UserDepartmentsController,
    PasswordResetController,
    ForgotPasswordController,
  ],
  // TASK-388 #10 — export serialization (exceljs/pdfkit) consumed by UserController.
  providers: [UserExportService],
})
export class UserModule {}
