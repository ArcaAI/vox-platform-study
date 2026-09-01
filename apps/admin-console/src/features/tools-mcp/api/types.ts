/**
 * Wire types for the Tools & MCP registry (screen 5 →
 * mcp-admin). Mirrors `McpServerResponse` / `McpServerListResponse` from
 * `@arcaai/applications`. Features never import one another (rule 13), so the
 * shape is re-declared here.
 *
 * SECURITY: `authRef` is a Vault PATH only — never secret material. The UI
 * shows masked presence ("Configured" / "None"), not the path string in the
 * registry table.
 */

export type McpTransport = 'streamable-http';
export type McpPhiBoundary = 'external' | 'in-boundary';

export interface McpServer {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  baseUrl: string;
  transport: string;
  /** Vault path only (never a credential). Null when the server needs no auth. */
  authRef?: string | null;
  toolAllowlist?: string[] | null;
  phiBoundary: string;
  enabled: boolean;
  resourceStatus?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpServerListResponse {
  items: McpServer[];
  total: number;
}

export interface CreateMcpServerRequest {
  name: string;
  description?: string;
  baseUrl: string;
  transport?: McpTransport;
  authRef?: string;
  toolAllowlist?: string[];
  phiBoundary?: McpPhiBoundary;
  enabled?: boolean;
}

export interface UpdateMcpServerRequest {
  name?: string;
  description?: string;
  baseUrl?: string;
  transport?: McpTransport;
  authRef?: string;
  toolAllowlist?: string[];
  phiBoundary?: McpPhiBoundary;
  enabled?: boolean;
  expectedVersion?: number;
}

/**
 * The slice of `GET admin/harness/policy` this screen needs: the per-tenant MCP
 * master gate (OD-11). Resolved by the gateway on the tenant → SYSTEM cascade,
 * so the value here is already the EFFECTIVE one for the caller's tenant.
 * `null` ⇒ neither tier expressed an opinion ⇒ OFF.
 */
export interface McpGateResponse {
  mcpToolsEnabled?: boolean | null;
}
