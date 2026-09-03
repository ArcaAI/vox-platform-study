import { Inject, Injectable, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IProviderConnectionService } from '../../../ai-provider-connection/IProviderConnectionService';

const LIST_TIMEOUT_MS = 15000;

const CONFIGURE_HINT = 'configure the SYSTEM model-registry/huggingface provider connection';

export interface HuggingFaceFileEntry {
  path: string;
  size: number;
}

/**
 * Thin transport wrapper over the public HuggingFace Hub REST surface —
 * listing a repo's file tree and downloading one file. No retry/pagination
 * logic: HF's tree endpoint already returns the full recursive listing in
 * one response for repos this size (a handful of GGUF/config/tokenizer
 * files), and a failed download simply fails the job (BullMQ/the caller
 * decides whether to retry).
 *
 * Uses `httpService.axiosRef` directly (not `firstValueFrom(this.httpService
 * .get(...))`) — the same convention `KnowledgeIngestClient` uses elsewhere
 * in this package.
 *
 * authenticates against HuggingFace with the platform's
 * `HUGGINGFACE_TOKEN`, resolved from the SYSTEM-tenant
 * `model-registry`/`huggingface` `AiProviderConnection` row (owner ruling
 * 2026-08-24: this plane is platform-managed — only a super admin sets this
 * token, and it is the SAME token for every tenant's fetch, so the resolve is
 * pinned to `SYSTEM_TENANT_ID` regardless of which tenant's `AiModel` is being
 * downloaded). Resolved fresh on every call rather than cached on the
 * instance: this client is a NestJS singleton, and a cached value would
 * survive a credential rotation until the next restart. The resolve is cheap
 * (one decrypt) next to the multi-megabyte transfers it authenticates.
 *
 * Three outcomes, and only one of them attaches a header — the other two are
 * NOT failures:
 *   - a token resolves -> `Authorization: Bearer <token>` is sent.
 *   - no row, a disabled row, or -> no header. A public repo (the common
 *     the resolve itself faults case — `blaze999/Medical-NER`,
 *                                     `unsloth/Qwen3-0.6B-GGUF`) must keep
 *                                     working with nobody having configured
 *                                     a token at all.
 * A 401/403 from HuggingFace itself — the caller lacked or presented a bad
 * token for a gated/private repo — is re-thrown as an actionable error naming
 * the fix, never a bare axios stack and never the token value.
 */
@Injectable()
export class HuggingFaceModelSourceClient {
  constructor(
    private readonly httpService: HttpService,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
  ) {}

  /** List every FILE (not directory) entry in `repo`'s tree, recursively. */
  async listRepoFiles(repo: string, revision = 'main'): Promise<HuggingFaceFileEntry[]> {
    const url = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=1`;
    const headers = await this.resolveAuthHeaders();

    try {
      const response = await this.httpService.axiosRef.get(url, { timeout: LIST_TIMEOUT_MS, headers });
      const entries = Array.isArray(response.data) ? response.data : [];
      return entries
        .filter((entry: Record<string, unknown>) => entry.type === 'file')
        .map((entry: Record<string, unknown>) => ({
          path: String(entry.path),
          size: Number((entry.lfs as Record<string, unknown> | undefined)?.size ?? entry.size ?? 0),
        }));
    } catch (error) {
      throw this.toRepoError(repo, error);
    }
  }

  /** Download one file's raw bytes. */
  async downloadFile(repo: string, path: string, revision = 'main'): Promise<Buffer> {
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
    const headers = await this.resolveAuthHeaders();

    try {
      const response = await this.httpService.axiosRef.get(url, { responseType: 'arraybuffer', headers });
      return Buffer.from(response.data as ArrayBuffer);
    } catch (error) {
      throw this.toRepoError(repo, error);
    }
  }

  /**
   * `{}` on every outcome except a resolved credential — absent, denied
   * (disabled row) and unavailable (the resolve itself faulted, e.g. Vault
   * down) all fall through to an unauthenticated request, exactly like a
   * caller with no `IProviderConnectionService` wired at all. None of those
   * are hard failures here; only HuggingFace's own 401/403 is (see
   * `toRepoError`).
   */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (!this.providerConnections) return {};

    const resolved = await this.providerConnections.resolveCredential('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    if (resolved.outcome !== 'resolved' || !resolved.apiKey) return {};

    return { Authorization: `Bearer ${resolved.apiKey}` };
  }

  /**
   * Never interpolates the raw axios error (its config can echo the
   * `Authorization` header back) and never touches the token — only the repo
   * id and HTTP status reach the message.
   */
  private toRepoError(repo: string, error: unknown): Error {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      return new Error(`HuggingFace rejected the request for '${repo}' (HTTP ${status}) — ${CONFIGURE_HINT} with a token that can read this repo.`);
    }
    return error instanceof Error ? error : new Error(`HuggingFace request for '${repo}' failed`);
  }
}
