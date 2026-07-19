import { McpServerAdminServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { McpAdminController } from './mcp-admin.controller';

/**
 * McpAdminModule (TASK-516 Phase 5) — mounts the `/admin/mcp-servers` surface.
 * `McpServerAdminService` (global-admin CRUD + SYSTEM-shared registry reads +
 * OCC) comes from `@arcaai/applications`; `ClsService` resolves from its global
 * module.
 */
@Module({
  imports: [McpServerAdminServiceModule],
  controllers: [McpAdminController],
})
export class McpAdminModule {}
