import { Module } from '@nestjs/common';
import { UserServiceModule, ApiKeyServiceModule, UserPreferencesServiceModule, UserSettingsServiceModule, UserRoleAssignmentServiceModule } from '@arcaai/applications';
import { UserController } from './user.controller';
import { UserPreferencesController } from './controllers/user-preferences.controller';
import { UserSettingsController } from './controllers/user-settings.controller';

@Module({
  imports: [UserServiceModule, ApiKeyServiceModule, UserPreferencesServiceModule, UserSettingsServiceModule, UserRoleAssignmentServiceModule],
  controllers: [UserController, UserPreferencesController, UserSettingsController],
})
export class UserModule {}
