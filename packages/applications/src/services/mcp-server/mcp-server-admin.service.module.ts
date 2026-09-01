import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EgressPolicyService } from '../../common/egress';
import { CommonServiceModule } from '../baseServices';
import { IMcpServerAdminService } from './IMcpServerAdminService';
import { McpServerAdminService } from './mcp-server-admin.service';

/**
 * McpServerAdminServiceModule — the MCP external-tools registry admin
 * service (super-admin CRUD + tenant-admin registry reads). Mirrors
 * `AiTaskDefaultServiceModule`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    // The SSRF egress guard for tenant-authored `baseUrl` (TASK-846 D-3). Provided
    // here rather than in CommonServiceModule because this is currently its only
    // consumer; it needs IAppSettingsService, which CommonServiceModule exports.
    EgressPolicyService,
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
