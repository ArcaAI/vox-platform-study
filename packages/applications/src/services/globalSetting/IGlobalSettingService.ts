import { EntityId, GlobalSettingEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateGlobalSettingRequest, RotateGlobalSettingRequest, UpdateGlobalSettingRequest } from './dto';

export interface IGlobalSettingService extends IBaseService {
  create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity>;
  /** TASK-443 — `secretsOnly` resolves the derived secret predicate server-side (no `isSecret` column). */
  fetchAll(props: PaginatedQuery & { secretsOnly?: boolean }): Promise<FetchResponse<GlobalSettingEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string; secretsOnly?: boolean }): Promise<FetchResponse<GlobalSettingEntity>>;
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
  /**
   * TASK-445 — rotate ONE secret setting: atomically replace the stored secret
   * value under optimistic concurrency (`updateWithVersion`), invalidating the
   * old value in the same versioned write. Super-admin only (re-checked here,
   * primary gate is the HTTP layer's CASL `manage:all`) + step-up re-auth like
   * `revealSecret`. Emits a force-audited `ResourceUpdated` SysEvent tagged
   * `GLOBAL_SETTING_SECRET_ROTATED` that NEVER contains the old or new
   * plaintext. Non-secret rows are rejected. Returns the persisted entity
   * (masked by the DTO mapper at the HTTP layer — the plaintext is never
   * returned).
   */
  rotateSecret(id: EntityId, request: RotateGlobalSettingRequest): Promise<GlobalSettingEntity>;
}
export const IGlobalSettingService = Symbol('IGlobalSettingService');
