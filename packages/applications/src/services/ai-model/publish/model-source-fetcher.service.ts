import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AiModelSource } from '@arcaai/domains';
import { IS3Service } from '../../baseServices/storage';
import { HOPE_MODELS_MOUNT } from '../constants';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import {
  FreeSpaceProbe,
  MODEL_STAGING_FREE_SPACE,
  assertStagingSpace,
  createStagingFreeSpaceProbe,
  resolveStagingBaseDir,
  resolveStagingMaxBytes,
  stagingPathFor,
} from './model-staging';
import { isRelevantModelSourceFile, sha256Hex } from './model-version.util';

/** A source file staged on local disk, hashed, ready to upload (TASK-1019 D-3). */
export interface StagedModelFile {
  /** Path relative to the model's "root" — the S3 key this file publishes under, once versioned. */
  path: string;
  /** Where the bytes are on the worker's disk (inside the job's staging directory). */
  localPath: string;
  size: number;
  sha256: string;
}

export interface FetchStagingOptions {
  /** The job's private staging directory; every file lands under it. */
  stagingDir: string;
  /** Hub revision to fetch at (the resolved commit sha); `main` when absent. */
  revision?: string;
  /** Called once, after the pre-flight, with the total bytes about to be fetched. */
  onPlanned?: (totalBytes: number) => void;
  /** Called per received chunk — progress + liveness. */
  onBytes?: (bytes: number) => void;
  /** A Hub download receiving no byte for this long is aborted (`DOWNLOAD_IDLE_TIMEOUT`, I7). */
  idleTimeoutMs?: number;
  /** TASK-1023 D-C — an admin cancel: checked between files and threaded into each Hub download. */
  signal?: AbortSignal;
  /** TASK-1023 OD-3 — the JOB's tenant, whose HF credential is used (default SYSTEM). */
  tenantId?: string;
}

const HF_REPO_RE = /^(?:hf:)?([\w.-]+\/[\w.-]+)$/;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.*)$/;

/**
 * Fetch a model's source files given `AiModel.source` + `AiModel.sourceUri`,
 * STAGING each to local disk (TASK-1019 D-3). Hub files are streamed straight
 * to disk while hashed — a weight file never exists as one Buffer. Before any
 * byte is fetched the selected files' total size is checked against the
 * staging directory's free space — min(filesystem free, the pod's
 * `MODEL_PUBLISHER_STAGING_MAX_BYTES` budget − bytes already staged) —
 * (`STAGING_SPACE_INSUFFICIENT`).
 *
 * `source` is checked FIRST (TASK-960 D1): a `LOCAL` row's weights are
 * expected already staged under the `hope-models` bucket mount — there is
 * nothing to fetch, and this must be refused before any scheme dispatch
 * runs. Dispatching on the shape of `sourceUri` alone used to send a LOCAL
 * row's bucket-relative prefix (e.g. `hope-models/arcaai-whisper-en-2609`) to
 * the HuggingFace Hub whenever it happened to look like `org/repo`, which
 * produced a misleading HTTP 401 (the repo does not exist on the Hub, so no
 * token could ever fix it).
 *
 * For every other source, two schemes only, per the download contract: a
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
  private readonly freeSpace: FreeSpaceProbe;

  constructor(
    private readonly hfClient: HuggingFaceModelSourceClient,
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    @Optional() @Inject(MODEL_STAGING_FREE_SPACE) freeSpace?: FreeSpaceProbe,
  ) {
    // The pod's budget, not just the node's disk (I8).
    this.freeSpace = freeSpace ?? createStagingFreeSpaceProbe({ baseDir: resolveStagingBaseDir(), budgetBytes: resolveStagingMaxBytes() });
  }

  async fetch(source: AiModelSource, sourceUri: string, quantFilter: string | null, opts: FetchStagingOptions): Promise<StagedModelFile[]> {
    if (source === AiModelSource.LOCAL) {
      throw new Error(
        `AiModel source is LOCAL: its weights are expected to already be staged under the '${HOPE_MODELS_MOUNT}' bucket mount, so there is nothing to fetch. Set 'bucketPrefix' (and 'primaryObject' for a single-file loader) to register the already-staged files instead of triggering a download.`,
      );
    }

    const s3Match = sourceUri.match(S3_URI_RE);
    if (s3Match) {
      const [, bucket, prefix] = s3Match;
      return this.fetchFromS3(bucket, prefix, opts);
    }

    const hfMatch = sourceUri.match(HF_REPO_RE);
    if (hfMatch) {
      return this.fetchFromHuggingFace(hfMatch[1], quantFilter, opts);
    }

    throw new Error(`Unsupported model source for download: '${sourceUri}' (only a HuggingFace repo id or an s3:// prefix are supported)`);
  }

  private async fetchFromHuggingFace(repo: string, quantFilter: string | null, opts: FetchStagingOptions): Promise<StagedModelFile[]> {
    const revision = opts.revision ?? 'main';
    const entries = await this.hfClient.listRepoFiles(repo, revision, { tenantId: opts.tenantId });
    const relevant = entries.filter((entry) => isRelevantModelSourceFile(entry.path));
    const selected = quantFilter ? relevant.filter((entry) => matchesQuantOrIsCompanion(entry.path, quantFilter)) : relevant;

    if (selected.length === 0) {
      throw new Error(`No downloadable files found for HuggingFace source '${repo}'${quantFilter ? ` matching quant '${quantFilter}'` : ''}`);
    }

    // Resolve every destination BEFORE the pre-flight: a hostile path fails
    // the job without a byte fetched.
    const planned = selected.map((entry) => ({ entry, localPath: stagingPathFor(opts.stagingDir, entry.path) }));
    const totalBytes = selected.reduce((sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : 0), 0);
    await assertStagingSpace(opts.stagingDir, totalBytes, this.freeSpace);
    opts.onPlanned?.(totalBytes);

    const files: StagedModelFile[] = [];
    for (const { entry, localPath } of planned) {
      opts.signal?.throwIfAborted();
      const { size, sha256 } = await this.hfClient.downloadFileTo(repo, entry.path, revision, localPath, opts.onBytes, {
        idleTimeoutMs: opts.idleTimeoutMs,
        signal: opts.signal,
        tenantId: opts.tenantId,
      });
      files.push({ path: entry.path, localPath, size, sha256 });
    }
    return files;
  }

  /**
   * An existing `s3://` prefix, read through the platform `IS3Service`. That
   * interface has no streaming read, so each object passes through memory ONCE
   * on its way to the staging file — acceptable for the re-publish-an-already-
   * staged-prefix case this path serves; Hub downloads (the large ones) stream.
   */
  private async fetchFromS3(bucket: string, prefix: string, opts: FetchStagingOptions): Promise<StagedModelFile[]> {
    const listed = await this.s3Service.listFiles(bucket, prefix);
    const relevant = (listed as Array<{ key: string; size?: number }>).filter((item) => isRelevantModelSourceFile(item.key));

    if (relevant.length === 0) {
      throw new Error(`No downloadable files found at 's3://${bucket}/${prefix}'`);
    }

    const planned = relevant.map((item) => {
      const relativePath = item.key.startsWith(prefix) ? item.key.slice(prefix.length).replace(/^\/+/, '') : item.key;
      const path = relativePath || item.key;
      return { item, path, localPath: stagingPathFor(opts.stagingDir, path) };
    });
    const totalBytes = relevant.reduce((sum, item) => sum + Number(item.size ?? 0), 0);
    await assertStagingSpace(opts.stagingDir, totalBytes, this.freeSpace);
    opts.onPlanned?.(totalBytes);

    const files: StagedModelFile[] = [];
    for (const { item, path, localPath } of planned) {
      opts.signal?.throwIfAborted();
      const data = await this.s3Service.getFile(bucket, item.key);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, data);
      opts.onBytes?.(data.length);
      files.push({ path, localPath, size: data.length, sha256: sha256Hex(data) });
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
  // `.bin` is quantised only as a whisper.cpp `ggml-*` file; a plain checkpoint (`pytorch_model.bin`)
  // is the repo's only weights, and a dtype computeType ('float32') must never filter it out.
  if (base.endsWith('.bin') && !base.startsWith('ggml')) return true;
  if (base.includes('mmproj')) return true;
  const normalizedFilter = quantFilter.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normalizedBase = base.replace(/[^a-z0-9]+/g, '');
  return normalizedBase.includes(normalizedFilter);
}
