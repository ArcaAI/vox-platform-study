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
import { UserMeRedirectShimController } from './controllers/user-me-redirect.shim.controller';
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
  // TASK-760 — ORDER IS LOAD-BEARING, not cosmetic. Nest matches routes in
  // controller-registration order, so every LITERAL-segment controller under
  // the `users` collection must be registered BEFORE `UserRolesController`,
  // which is `@Controller('users')` carrying the PARAMETER route
  // `@Get(':id/roles')`. Registered the other way round, `:id` swallows the
  // literal `me` segment and `GET /users/me/...` silently resolves to the
  // by-id handler with `id === 'me'`. Pinned by
  // `controllers/__tests__/users-me-route-precedence.test.ts` — do not
  // reorder this array without reading that test.
  controllers: [
    UserController,
    UserPreferencesController,
    UserSettingsController,
    UserDepartmentsMeController,
    PasswordResetController,
    UserRolesController,
    UserDepartmentsController,
    ForgotPasswordController,
    UserMeRedirectShimController,
  ],
  // Export serialization (exceljs/pdfkit) consumed by UserController.
  providers: [UserExportService],
})
export class UserModule {}
