export interface TenantAllowedOrigin {
  id: string;
  tenantId: string;
  isPlatform: boolean;
  origin: string;
  label: string;
  description?: string;
  resourceStatus?: 'ENABLED' | 'DISABLED';
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateAllowedOriginRequest {
  origin: string;
  label: string;
  description?: string;
}

export interface UpdateAllowedOriginRequest {
  origin?: string;
  label?: string;
  description?: string | null;
}

/** FR-4 — the one platform-wide fact a tenant admin needs: is origin enforcement on? */
export interface AllowedOriginPosture {
  enforcementEnabled: boolean;
}
