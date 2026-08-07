import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IMcpServerAdminService } from './IMcpServerAdminService';
import { McpServerAdminService } from './mcp-server-admin.service';

/**
 * McpServerAdminServiceModule — the MCP external-tools registry admin
 * service (global-admin CRUD + tenant-admin registry reads). Mirrors
 * `AiTaskDefaultServiceModule`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    McpServerAdminService,
    {
      provide: IMcpServerAdminService,
      // useExisting, not useClass — useClass would construct a second
      // McpServerAdminService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: McpServerAdminService,
    },
  ],
  exports: [IMcpServerAdminService, McpServerAdminService],
})
export class McpServerAdminServiceModule {}
