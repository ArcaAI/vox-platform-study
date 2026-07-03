import { EntityId, GlobalSettingEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateGlobalSettingRequest, UpdateGlobalSettingRequest } from './dto';

// TODO: Implement this

export interface IGlobalSettingService extends IBaseService {
  create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchById(id: EntityId): Promise<GlobalSettingEntity>;
  update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity>;
  deleteById(id: EntityId): Promise<GlobalSettingEntity>;
  /**
   * TASK-396 — reveal ONE setting's decrypted plaintext.
   *
   * Super-admin only (enforced at the HTTP layer via CASL `manage all`, and
   * re-checked here for defense in depth) + step-up re-auth: `password` is the
   * caller's current account password, verified against the stored bcrypt hash.
   * Emits an audit SysEvent (actor, key, id, timestamp) that NEVER contains the
   * plaintext. Decrypts via the same repository crypto path used to write
   * `encryptedValue`.
   */
  revealSecret(id: EntityId, password: string): Promise<{ entity: GlobalSettingEntity; plaintext: string }>;
}
export const IGlobalSettingService = Symbol('IGlobalSettingService');
