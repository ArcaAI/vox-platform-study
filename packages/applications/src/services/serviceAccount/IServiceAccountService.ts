import { IServiceAccountPrincipal } from '../../interfaces';
import {
  CreateServiceAccountRequest,
  ServiceAccountResponse,
  ServiceAccountSecretResponse,
  ServiceAccountTokenRequest,
  ServiceAccountTokenResponse,
  UpdateServiceAccountRequest,
} from './dto';

export const IServiceAccountService = Symbol('IServiceAccountService');

export interface IServiceAccountService {
  create(dto: CreateServiceAccountRequest): Promise<ServiceAccountSecretResponse>;
  getAll(): Promise<ServiceAccountResponse[]>;
  getById(id: string): Promise<ServiceAccountResponse>;
  update(id: string, dto: UpdateServiceAccountRequest, expectedVersion: number): Promise<ServiceAccountResponse>;
  rotate(id: string, overlapSeconds?: number): Promise<ServiceAccountSecretResponse>;
  revoke(id: string): Promise<void>;
  exchangeToken(dto: ServiceAccountTokenRequest, ipAddress: string): Promise<ServiceAccountTokenResponse>;
  /** Called by `UnifiedAuthGuard`'s service-account branch on every request. */
  authenticateByToken(token: string): Promise<IServiceAccountPrincipal | null>;
  hasScope(principal: IServiceAccountPrincipal, requiredScope: string): boolean;
}
