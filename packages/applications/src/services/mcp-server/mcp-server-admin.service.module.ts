import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IMcpServerAdminService } from './IMcpServerAdminService';
import { McpServerAdminService } from './mcp-server-admin.service';

/**
 * McpServerAdminServiceModule (TASK-516) — the MCP external-tools registry admin
 * service (global-admin CRUD + tenant-admin registry reads). Mirrors
 * `AiTaskDefaultServiceModule`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IMcpServerAdminService,
      useClass: McpServerAdminService,
    },
    McpServerAdminService,
  ],
  exports: [IMcpServerAdminService, McpServerAdminService],
})
export class McpServerAdminServiceModule {}
