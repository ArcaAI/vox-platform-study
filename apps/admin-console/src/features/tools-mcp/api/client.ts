/**
 * Tools & MCP client. All paths are
 * gateway-relative; the shared core prepends the `/api/hope` BFF proxy mount.
 * SUPER_ADMIN writes target the SYSTEM registry by default (omit ?tenantId=).
 * PATCH/DELETE require If-Match OCC.
 */

import { getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { CreateMcpServerRequest, McpGateResponse, McpServer, McpServerListResponse, UpdateMcpServerRequest } from './types';

const BASE = 'admin/mcp-servers';

/** Strong ETag from a list-row version (for DELETE OCC without a prior getWithEtag). */
export function etagFromVersion(version: number): string {
  return `"${version}"`;
}

/** SYSTEM registry list (super-admin; omit tenantId → service defaults to SYSTEM). */
export function listMcpServers(): Promise<McpServerListResponse> {
  return getJson(BASE);
}

export function getMcpServer(id: string): Promise<WithEtag<McpServer>> {
  return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function createMcpServer(body: CreateMcpServerRequest): Promise<McpServer> {
  return postJson(BASE, body);
}

/** OCC PATCH: If-Match + body expectedVersion folded from the read ETag. */
export function updateMcpServer(id: string, patch: UpdateMcpServerRequest, etag: string): Promise<WithEtag<McpServer>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** OCC soft-delete: If-Match required (412 on drift, 428 when missing). */
export function deleteMcpServer(id: string, etag: string): Promise<McpServer> {
  return request<McpServer>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', etag }).then((result) => result.data);
}

/**
 * The effective MCP master gate for the caller's tenant (OD-11). Read off the
 * harness policy, which the gateway already resolves tenant → SYSTEM, so no
 * cascade is reimplemented here. Registering a connector while this is off
 * leaves it configured but never invocable — the screen says so rather than
 * letting the user discover it at runtime.
 */
export function getMcpGate(): Promise<McpGateResponse> {
  return getJson('admin/harness/policy');
}
