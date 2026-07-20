import { AiRuntimeProfileResponse, UpsertAiRuntimeProfileRequest } from './dto';

/**
 * The per-field merge of `profile(modelSlug)` over `profile(provider default)`.
 * Every field is nullable; null means "no opinion — the consuming service's own
 * env/pydantic default wins".
 */
export interface ResolvedRuntimeProfile {
  provider: string;
  modelSlug: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxConcurrent: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  timeoutS: number | null;
  keepAliveSeconds: number | null;
  extraJson: Record<string, unknown> | null;
  /** True when no field carries an opinion — the caller should inject nothing. */
  isEmpty: boolean;
}

export const IAiRuntimeProfileService = Symbol('IAiRuntimeProfileService');

export interface IAiRuntimeProfileService {
  /** Every ENABLED SYSTEM profile row. */
  list(): Promise<AiRuntimeProfileResponse[]>;

  /** One profile row; a `version: 0` placeholder when absent. */
  getProfile(provider: string, modelSlug: string): Promise<AiRuntimeProfileResponse>;

  /** Create-or-CAS-update one profile row. Global-admin + SYSTEM-tenant only. */
  upsertProfile(provider: string, modelSlug: string, dto: UpsertAiRuntimeProfileRequest, tenantId?: string): Promise<AiRuntimeProfileResponse>;

  /** Soft-delete one profile row. */
  deleteProfile(provider: string, modelSlug: string, tenantId?: string): Promise<void>;

  /**
   * The injection cascade: `profile(modelSlug)` merged over
   * `profile(provider default, '')`, per field. Never throws for a missing
   * row — an absent profile resolves to all-null / `isEmpty: true`, which is
   * the "inject nothing, let the service env win" signal.
   */
  resolveProfile(provider: string, modelSlug: string): Promise<ResolvedRuntimeProfile>;
}
