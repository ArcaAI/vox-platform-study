/**
 * Wire types for the Tools & MCP registry (TASK-512 screen 5 → TASK-516
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
