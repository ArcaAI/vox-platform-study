import { Inject, Injectable } from '@nestjs/common';
import { IS3Service } from '../../baseServices/storage';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import { isRelevantModelSourceFile, sha256Hex } from './model-version.util';

export interface FetchedModelFile {
  /** Path relative to the model's "root" — the S3 key this file publishes under, once versioned. */
  path: string;
  data: Buffer;
  sha256: string;
}

const HF_REPO_RE = /^(?:hf:)?([\w.-]+\/[\w.-]+)$/;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.*)$/;

/**
 * Fetch a model's source files given `AiModel.sourceUri`.
 *
 * Two schemes only, per the download contract: a
 * HuggingFace repo id (`hf:<org>/<repo>` or a bare `org/repo`), or an
 * existing `s3://bucket/prefix` (e.g. re-publishing something already staged
 * outside `hope-models`). Anything else — `file://`, `azure-blob://`, a bare
 * URL — is a hard error; there is no silent fallback, matching the scheme
 * dispatch every other `sourceUri` consumer in this platform already uses
 * (`resolve_model_dir` in the Python services).
 *
 * `quantFilter`, when supplied, narrows which `.gguf` files are pulled out
 * of a source that hosts more than one quantization side by side — matched
 * as a case/separator-insensitive substring against the filename. Non-GGUF
 * companions (config/tokenizer) and any `mmproj` projector file are always
 * included regardless of the filter, since a multimodal model's projector
 * filename does not carry the weights' quant token.
 */
@Injectable()
export class ModelSourceFetcherService {
  constructor(
    private readonly hfClient: HuggingFaceModelSourceClient,
    @Inject(IS3Service) private readonly s3Service: IS3Service,
  ) {}

  async fetch(sourceUri: string, quantFilter: string | null): Promise<FetchedModelFile[]> {
    const s3Match = sourceUri.match(S3_URI_RE);
    if (s3Match) {
      const [, bucket, prefix] = s3Match;
      return this.fetchFromS3(bucket, prefix);
    }

    const hfMatch = sourceUri.match(HF_REPO_RE);
    if (hfMatch) {
      return this.fetchFromHuggingFace(hfMatch[1], quantFilter);
    }

    throw new Error(`Unsupported model source for download: '${sourceUri}' (only a HuggingFace repo id or an s3:// prefix are supported)`);
  }

  private async fetchFromHuggingFace(repo: string, quantFilter: string | null): Promise<FetchedModelFile[]> {
    const entries = await this.hfClient.listRepoFiles(repo);
    const relevant = entries.filter((entry) => isRelevantModelSourceFile(entry.path));
    const selected = quantFilter ? relevant.filter((entry) => matchesQuantOrIsCompanion(entry.path, quantFilter)) : relevant;

    if (selected.length === 0) {
      throw new Error(`No downloadable files found for HuggingFace source '${repo}'${quantFilter ? ` matching quant '${quantFilter}'` : ''}`);
    }

    const files: FetchedModelFile[] = [];
    for (const entry of selected) {
      const data = await this.hfClient.downloadFile(repo, entry.path);
      files.push({ path: entry.path, data, sha256: sha256Hex(data) });
    }
    return files;
  }

  private async fetchFromS3(bucket: string, prefix: string): Promise<FetchedModelFile[]> {
    const listed = await this.s3Service.listFiles(bucket, prefix);
    const relevant = (listed as Array<{ key: string }>).filter((item) => isRelevantModelSourceFile(item.key));

    if (relevant.length === 0) {
      throw new Error(`No downloadable files found at 's3://${bucket}/${prefix}'`);
    }

    const files: FetchedModelFile[] = [];
    for (const item of relevant) {
      const data = await this.s3Service.getFile(bucket, item.key);
      const relativePath = item.key.startsWith(prefix) ? item.key.slice(prefix.length).replace(/^\/+/, '') : item.key;
      files.push({ path: relativePath || item.key, data, sha256: sha256Hex(data) });
    }
    return files;
  }
}

/**
 * Extensions whose filenames carry a quantisation token. `.safetensors` is
 * deliberately ABSENT: a repo publishes one safetensors set, unquantised, so
 * applying a quant filter to it would exclude the only weights present.
 */
const QUANTISABLE_WEIGHT_EXTENSIONS = ['.gguf', '.bin'] as const;

/**
 * A quantised WEIGHT file matching the filter, OR any companion/projector file.
 *
 * this used to exempt everything that was not `.gguf`, which was
 * correct while GGUF was the only quantised format fetched. Now that
 * `isRelevantModelSourceFile` also accepts `.bin`/`.safetensors`, that
 * exemption would silently defeat the filter: `taphuynh/whisper-…-gguf` ships
 * `ggml-…-f16.bin`, `-q5_0.bin` and `-q8_0.bin`, so a `Q5_0` request would
 * publish all three — ~3x the bytes, and an ambiguous prefix with no way for a
 * consumer to tell which file to serve.
 */
function matchesQuantOrIsCompanion(path: string, quantFilter: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (!QUANTISABLE_WEIGHT_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (base.includes('mmproj')) return true;
  const normalizedFilter = quantFilter.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normalizedBase = base.replace(/[^a-z0-9]+/g, '');
  return normalizedBase.includes(normalizedFilter);
}
