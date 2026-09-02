import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

const LIST_TIMEOUT_MS = 15000;

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
 */
@Injectable()
export class HuggingFaceModelSourceClient {
  constructor(private readonly httpService: HttpService) {}

  /** List every FILE (not directory) entry in `repo`'s tree, recursively. */
  async listRepoFiles(repo: string, revision = 'main'): Promise<HuggingFaceFileEntry[]> {
    const url = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=1`;
    const response = await this.httpService.axiosRef.get(url, { timeout: LIST_TIMEOUT_MS });

    const entries = Array.isArray(response.data) ? response.data : [];
    return entries
      .filter((entry: Record<string, unknown>) => entry.type === 'file')
      .map((entry: Record<string, unknown>) => ({
        path: String(entry.path),
        size: Number((entry.lfs as Record<string, unknown> | undefined)?.size ?? entry.size ?? 0),
      }));
  }

  /** Download one file's raw bytes. */
  async downloadFile(repo: string, path: string, revision = 'main'): Promise<Buffer> {
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
    const response = await this.httpService.axiosRef.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data as ArrayBuffer);
  }
}
