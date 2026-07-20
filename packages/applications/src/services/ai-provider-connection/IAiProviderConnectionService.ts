import { AiProviderConnectionEntity } from '@arcaai/domains';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

/** The resolved connection plus which cascade tier supplied it. */
export interface ResolvedProviderConnection {
  provider: string;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  /** Ciphertext — gateway-side decrypt only; never leaves the server. */
  encryptedApiKey: Uint8Array | null;
  keyVersion: number | null;
  /** Which tier won: the caller's own row or the SYSTEM platform default. */
  source: 'tenant' | 'system';
}

export const IAiProviderConnectionService = Symbol('IAiProviderConnectionService');

export interface IAiProviderConnectionService {
  /** Every ENABLED connection row for a tenant, masked. */
  list(tenantId?: string): Promise<AiProviderConnectionResponse[]>;

  /** One (tenant, provider) row, masked; a `version: 0` placeholder when absent. */
  getRow(provider: string, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /** Create-or-CAS-update one (tenant, provider) row. */
  upsertRow(provider: string, dto: UpsertAiProviderConnectionRequest, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /** Soft-delete one (tenant, provider) row. */
  deleteRow(provider: string, tenantId?: string): Promise<void>;

  /**
   * The resolution cascade: ENABLED tenant row → ENABLED SYSTEM row → null.
   * `null` is the "no DB opinion — use the service's env configuration" signal.
   * Server-side only; the result carries ciphertext and is never serialized to
   * a client.
   */
  resolveConnection(provider: string, tenantId: string): Promise<ResolvedProviderConnection | null>;

  /** Raw entity accessor for gateway resolution paths that need the row itself. */
  findRow(provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null>;
}
