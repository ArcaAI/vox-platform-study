import { EffectiveSettingsModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { SettingsCatalogController } from './settings-catalog.controller';

/**
 * TASK-504 Phase 3c — mounts `GET /admin/settings/catalog`. No service deps: the
 * catalog is served directly from the in-code `HOPE_SETTINGS_REGISTRY`; only
 * `ClsService` (globally registered) is used, to RBAC-filter global-only entries.
 *
 * MUST be imported before `GlobalSettingModule` in `app.module` so the static
 * `admin/settings/catalog` route registers ahead of `admin/settings/:id`.
 */
@Module({
  imports: [EffectiveSettingsModule],
  controllers: [SettingsCatalogController],
})
export class SettingsCatalogModule {}
