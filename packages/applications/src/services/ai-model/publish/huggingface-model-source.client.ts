import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { DOWNLOAD_IDLE_TIMEOUT, ModelPublisherError } from './model-publisher.errors';
import { MODEL_PUBLISHER_TIMEOUT_DEFAULTS } from './model-publisher-timeouts.settings';

const LIST_TIMEOUT_MS = 15000;

const CONFIGURE_HINT = 'configure the SYSTEM model-registry/huggingface provider connection';

export interface HuggingFaceFileEntry {
  path: string;
  size: number;
}

/**
 * The model-card facts the registry mirrors (TASK-860 R-3): the Hub commit
 * `sha` (the HF-cache snapshot directory name and `AiModel.hfRevision`), the
 * licence, whether the repo is gated, and the two taxonomy facets.
 */
export interface HuggingFaceRepoInfo {
  sha: string;
  gated: boolean;
  license: string | null;
  pipelineTag: string | null;
  libraryName: string | null;
  languages: string[];
}

/**
 * Thin transport wrapper over the public HuggingFace Hub REST surface —
 * listing a repo's file tree, reading its card, and streaming one file to
 * disk. No retry/pagination
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

  /**
   * Read the repo's metadata at `revision` — commit sha + the card facts.
   * Same auth + error posture as the other two calls.
   */
  async getRepoInfo(repo: string, revision = 'main'): Promise<HuggingFaceRepoInfo> {
    const url = `https://huggingface.co/api/models/${repo}?revision=${encodeURIComponent(revision)}`;
    const headers = await this.resolveAuthHeaders();

    try {
      const response = await this.httpService.axiosRef.get(url, { timeout: LIST_TIMEOUT_MS, headers });
      const data = (response.data ?? {}) as Record<string, unknown>;
      const card = (data.cardData ?? {}) as Record<string, unknown>;
      const language = card.language;
      return {
        sha: String(data.sha ?? ''),
        // The Hub reports `gated` as false | 'auto' | 'manual'.
        gated: data.gated !== false && data.gated !== undefined && data.gated !== null,
        license: typeof card.license === 'string' ? card.license : null,
        pipelineTag: typeof data.pipeline_tag === 'string' ? data.pipeline_tag : null,
        libraryName: typeof data.library_name === 'string' ? data.library_name : null,
        languages: Array.isArray(language)
          ? language.filter((l): l is string => typeof l === 'string')
          : typeof language === 'string'
            ? [language]
            : [],
      };
    } catch (error) {
      throw this.toRepoError(repo, error);
    }
  }

  /**
   * Stream one file to `destPath` while hashing it (TASK-1019 D-3): the body
   * is piped chunk by chunk through sha256 into a file, so a multi-gigabyte
   * weight never exists as one Buffer. `onBytes` is called per chunk (progress
   * + liveness). Parent directories of `destPath` are created. A body that
   * errors mid-transfer rejects; the partial file is the caller's staging
   * directory to clean up.
   *
   * BYTE-IDLE WATCHDOG (I7). A half-open socket delivers nothing and never
   * errors, so without a bound the job — and the concurrency-1 queue behind it
   * — hangs forever. If no byte (or no response) arrives for `idleTimeoutMs`,
   * the request is aborted and the call rejects with the RETRYABLE
   * `DOWNLOAD_IDLE_TIMEOUT`. Every chunk restarts the clock, so a slow but
   * moving transfer is never cut off.
   */
  async downloadFileTo(
    repo: string,
    path: string,
    revision: string,
    destPath: string,
    onBytes?: (bytes: number) => void,
    opts: { idleTimeoutMs?: number } = {},
  ): Promise<{ size: number; sha256: string }> {
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
    const idleTimeoutMs = opts.idleTimeoutMs ?? MODEL_PUBLISHER_TIMEOUT_DEFAULTS.idleTimeoutSeconds * 1000;
    const headers = await this.resolveAuthHeaders();
    // Before the request: once the body stream exists, nothing may be awaited
    // until `pipeline` owns it, or an early socket error has no listener.
    await mkdir(dirname(destPath), { recursive: true });

    const controller = new AbortController();
    let body: Readable | null = null;
    let idle: ModelPublisherError | null = null;
    let timer: NodeJS.Timeout | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        idle = new ModelPublisherError(DOWNLOAD_IDLE_TIMEOUT, `no data from HuggingFace for ${Math.round(idleTimeoutMs / 1000)} s while downloading '${path}' of '${repo}'`);
        controller.abort(idle);
        body?.destroy(idle);
      }, idleTimeoutMs);
      timer.unref?.();
    };

    arm();
    try {
      try {
        const response = await this.httpService.axiosRef.get(url, { responseType: 'stream', headers, signal: controller.signal });
        body = response.data as Readable;
      } catch (error) {
        throw idle ?? this.toRepoError(repo, error);
      }
      if (idle) {
        body.destroy(idle);
        throw idle;
      }

      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          arm();
          size += chunk.length;
          hash.update(chunk);
          onBytes?.(chunk.length);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(body, meter, createWriteStream(destPath));
      } catch (error) {
        throw idle ?? error;
      }
      return { size, sha256: hash.digest('hex') };
    } finally {
      if (timer) clearTimeout(timer);
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
