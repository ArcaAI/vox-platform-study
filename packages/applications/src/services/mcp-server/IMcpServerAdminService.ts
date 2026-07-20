import { CreateMcpServerRequest, McpServerListResponse, McpServerResponse, UpdateMcpServerRequest } from './dto';

/**
 * MCP external-tools registry admin service.
 *
 * Reads (list/get) are available to tenant admins over the SYSTEM-shared
 * registry (backs the console "Tools & MCP" screen); a cross-tenant
 * read is 404 (no-existence-leak). WRITES (create/update/remove) are
 * GLOBAL-ADMIN-ONLY — a tenant-admin write gets a `ForbiddenException` (403),
 * the guardrail.* privilege-boundary precedent. `tenantId` is optional on every
 * method: omitted ⇒ the CLS tenant; a global admin targets any tenant (default
 * SYSTEM for writes, since registry rows are SYSTEM-owned initially).
 */
export interface IMcpServerAdminService {
  list(tenantId?: string): Promise<McpServerListResponse>;
  get(id: string, tenantId?: string): Promise<McpServerResponse>;
  create(dto: CreateMcpServerRequest, tenantId?: string): Promise<McpServerResponse>;
  update(id: string, dto: UpdateMcpServerRequest, expectedVersion: number | undefined, tenantId?: string): Promise<McpServerResponse>;
  remove(id: string, expectedVersion: number | undefined, tenantId?: string): Promise<McpServerResponse>;
}

export const IMcpServerAdminService = Symbol('IMcpServerAdminService');
