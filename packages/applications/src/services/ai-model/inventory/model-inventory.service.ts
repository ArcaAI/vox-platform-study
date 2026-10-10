import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AiModelAvailability,
  AiModelEntity,
  AiModelRepository,
  AiModelSource,
  CoreDatabaseService,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { ClsService } from 'nestjs-cls';
import { IS3Service } from '../../baseServices/storage';
import { IActiveUserContext } from '../../../interfaces';
import { assertPlatformRegistryAdmin } from '../lifecycle/platform-admin';
import { IRedisCacheService } from '../../baseServices/redis';
import { IInferenceReadinessService } from '../../ai-readiness/IInferenceReadinessService';
import { HOPE_MODELS_BUCKET, HOPE_MODELS_MOUNT, SINGLE_FILE_LIBRARIES } from '../constants';
import { lmStudioWireModelId } from '../serving-spec/lm-studio-wire-id';
import { isModelWeightFile, sha256Hex } from '../publish/model-version.util';
import { MODEL_INVENTORY_REPORT_KEY, MODEL_INVENTORY_REPORT_TTL_SECONDS } from './model-inventory.constants';
import type { ModelInventoryReport, ModelInventoryRow, UnregisteredBucketPrefix } from './dto';

/**
 * Libraries whose weights ship inside the Python package (nothing in the
 * bucket to inventory). Kept next to `HF_CACHE_LIBRARIES` in spirit; small
 * enough to live here.
 *
 * TASK-1030 — `deepfilternet` is NOT one of them: its wheel carries no
 * checkpoint (`init_df` would download it at session time), so its row is
 * published to the bucket like any other self-hosted model and inventoried.
 */
const WEIGHTLESS_LIBRARIES: ReadonlySet<string> = new Set(['pyrnnoise']);

const MANIFEST_OBJECT = 'manifest.json';
const FLAT_PREFIX_RE = /^([^/]+)\/([^/]+)\/$/;
const HF_SNAPSHOT_PREFIX_RE = /^hf\/hub\/models--[^/]+\/snapshots\/[^/]+\/$/;
/**
 * The HuggingFace cache tree. Every snapshot under it is a directory of
 * manifest-less weights, so STAGED discovery would report the whole cache as
 * adoptable. Manifest-BEARING prefixes inside it are still discovered by
 * `HF_SNAPSHOT_PREFIX_RE` above; this only bounds the manifest-less pass.
 */
const HF_CACHE_ROOT = 'hf/';
/** The HuggingFace hub cache inside it (`HF_HOME=/mnt/models-bucket/hf`), as `out-of-band/hope-models-publish.yaml` writes it. */
const HF_HUB_ROOT = `${HF_CACHE_ROOT}hub/`;
/**
 * TASK-1055 FU-3 — the single-file libraries whose loader picks its file by the BASENAME containing
 * the row's `computeType` (a ggml quant: `q8_0`, `f16`, `q6_k`) — stt `whisper_cpp_loader._select_gguf_file`,
 * and the llama.cpp GGUF naming. The other `SINGLE_FILE_LIBRARIES` members are excluded on purpose:
 * their `computeType` is a dtype (`float32` for Silero VAD) that no file name carries.
 */
const GGML_QUANT_LIBRARIES: ReadonlySet<string> = new Set([...SINGLE_FILE_LIBRARIES].filter((lib) => lib === 'whisper.cpp' || lib === 'llama.cpp'));
const LM_STUDIO_NAMES: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio']);

/** One entry of the single bucket listing a run performs. */
interface BucketObject {
  key: string;
  size?: number;
}

interface ManifestSummary {
  slug: string | null;
  version: string | null;
  objects: string[];
  totalBytes: number | null;
}

/**
 * ModelInventoryService — measures `AiModel.availability` (TASK-860 R-2,
 * README §3.4). Availability is a FACT about the bucket, so this service is
 * the ONLY writer of it besides the publish processor: it lists the bucket
 * once, verifies every SYSTEM catalogue row's `bucketPrefix` + `manifestDigest`
 * + manifest objects, stamps the verdict, and lists the manifest-bearing
 * prefixes no row references ("In bucket, not registered → Register").
 *
 * Runs with no CLS (cron) or as a super admin on demand; writes go through
 * the unscoped base client for the same reason `AiModelService`'s do.
 */
@Injectable()
export class ModelInventoryService {
  private readonly logger = new Logger(ModelInventoryService.name);

  /** The last report this process produced — the fallback when Redis is absent. */
  private lastReport: ModelInventoryReport | null = null;

  constructor(
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // TASK-890 J1 MINOR-6/7, both `@Optional()` and TRAILING so every existing
    // positional unit fixture keeps its arity. Neither is load-bearing for the
    // MEASUREMENT: without Redis the report is in-process only, and without the
    // readiness port the snapshot expires on its own TTL instead of being
    // refreshed. Absent collaborators degrade the follow-up, never the run.
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    @Optional() @Inject(IInferenceReadinessService) private readonly readiness?: { sweep(): Promise<unknown> },
    // TASK-1019 R3 — the request caller, for the platform-admin gate. Optional and
    // trailing for the same arity reason as the two above.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
  ) {}

  async runInventory(): Promise<ModelInventoryReport> {
    this.assertPlatformAdminCaller('run the model-bucket inventory');
    const checkedAt = new Date();

    // ONE listing — a bucket read error is surfaced, never turned into a
    // false MISSING on every row.
    const listed = (await this.s3Service.listFiles(HOPE_MODELS_BUCKET, '')) as BucketObject[];
    const keys = new Set(listed.map((item) => item.key));

    const rows = await this.aiModelRepository.findAll({
      filters: {
        tenantId: SYSTEM_TENANT_ID,
        resourceStatus: { in: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      } as any,
      sort: [{ name: 'asc' }],
    });

    const tx = this.databaseService.baseClient;
    const verdicts: ModelInventoryRow[] = [];
    const referencedPrefixes = new Set<string>();

    for (const row of rows) {
      const verdict = await this.measure(row, keys);
      row.markAvailability(verdict.availability, verdict.detail, checkedAt);
      await this.aiModelRepository.update(row.id, row, tx);
      if (row.bucketPrefix) referencedPrefixes.add(normalizePrefix(row.bucketPrefix));
      verdicts.push({ id: row.id, slug: row.slug, availability: verdict.availability, detail: verdict.detail });
    }

    const unregistered = await this.findUnregisteredPrefixes(listed, keys, referencedPrefixes);

    const counts = {
      available: verdicts.filter((v) => v.availability === AiModelAvailability.AVAILABLE).length,
      missing: verdicts.filter((v) => v.availability === AiModelAvailability.MISSING).length,
      partial: verdicts.filter((v) => v.availability === AiModelAvailability.PARTIAL).length,
      notApplicable: verdicts.filter((v) => v.availability === AiModelAvailability.NOT_APPLICABLE).length,
    };

    this.logger.log({ message: 'Model inventory completed', ...counts, unregistered: unregistered.length });

    const report: ModelInventoryReport = { checkedAt, counts, rows: verdicts, unregistered };
    this.lastReport = report;
    await this.storeReport(report);
    await this.refreshReadiness();

    return report;
  }

  /**
   * The last report, for `GET admin/ai-models/inventory` (J1 MINOR-7).
   *
   * `null` is a first-class answer — no run has been stored — and the console
   * says "not measured" rather than rendering a fabricated empty bucket.
   */
  async getLastReport(): Promise<ModelInventoryReport | null> {
    this.assertPlatformAdminCaller('read the model-bucket inventory');
    if (this.redisCache?.isConnected()) {
      try {
        const raw = await this.redisCache.get(MODEL_INVENTORY_REPORT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as ModelInventoryReport;
          // `checkedAt` round-trips through JSON as a string. Restore it so the
          // field means the same thing whichever path served the report.
          return { ...parsed, checkedAt: new Date(parsed.checkedAt) };
        }
      } catch (error) {
        this.logger.warn({
          message: 'Inventory report read failed; serving the in-process report',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.lastReport;
  }

  /**
   * TASK-1019 R3 (D-11) — inside a REQUEST the caller must be a tenant-less
   * platform admin. Outside one (the settings-gated cron runs with no CLS
   * context) there is no caller, and the sweep is the platform's own.
   */
  private assertPlatformAdminCaller(action: string): void {
    if (!this.clsService?.isActive()) return;
    assertPlatformRegistryAdmin(this.clsService.get('user'), this.clsService.get('tenantId') || null, action);
  }

  /** Publish the report so a reader in ANOTHER process (or a fresh tab) has it. */
  private async storeReport(report: ModelInventoryReport): Promise<void> {
    if (!this.redisCache?.isConnected()) return;
    try {
      await this.redisCache.setex(MODEL_INVENTORY_REPORT_KEY, MODEL_INVENTORY_REPORT_TTL_SECONDS, JSON.stringify(report));
    } catch (error) {
      this.logger.warn({
        message: 'Inventory report store failed; the report is in-process only',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Re-observe readiness now that availability has been rewritten (J1 MINOR-6).
   *
   * `AiModel.availability` is one of the two inputs to a self-hosted row's
   * readiness verdict, and the readiness snapshot is STORED with a TTL of three
   * sweep intervals — so without this, an operator who clicked "Run inventory"
   * kept being served a `readinessDetail` derived from the availability the run
   * had just replaced. An immediate re-sweep is cheaper and more honest than
   * dropping the snapshot: dropping it would report `unknown` on every row until
   * the next scheduled sweep, which is a worse answer than a fresh one.
   *
   * A sweep failure is logged and swallowed: the measurement this method follows
   * is already written, and failing the inventory over its follow-up would throw
   * away the valuable half of the work.
   */
  private async refreshReadiness(): Promise<void> {
    if (!this.readiness) return;
    try {
      await this.readiness.sweep();
    } catch (error) {
      this.logger.warn({
        message: 'Readiness re-sweep after the inventory failed; the stored snapshot stands until its TTL',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The verdict for one row, from the listing + (when needed) the manifest bytes. */
  private async measure(row: AiModelEntity, keys: Set<string>): Promise<{ availability: AiModelAvailability; detail: Record<string, unknown> }> {
    if (row.isCloud) {
      return { availability: AiModelAvailability.NOT_APPLICABLE, detail: { reason: 'cloud row — no weights in the bucket' } };
    }
    if (WEIGHTLESS_LIBRARIES.has(row.libraryName)) {
      return { availability: AiModelAvailability.NOT_APPLICABLE, detail: { reason: `${row.libraryName} ships its weights inside the package` } };
    }
    if (!row.bucketPrefix) {
      // TASK-1055 FU-3 — two layouts reach the bucket without a `bucketPrefix` on the row.
      if (isLmStudioRow(row)) return measureGgufTier(row, keys);
      if (row.source === AiModelSource.HUGGINGFACE) {
        const verdict = await this.measureHfCache(row, keys);
        if (verdict) return verdict;
      }
      return { availability: AiModelAvailability.MISSING, detail: { reason: 'no bucketPrefix — the row has never been published' } };
    }

    const prefix = normalizePrefix(row.bucketPrefix);

    // TASK-960 OD-1. A LOCAL row was staged in the bucket by an admin through
    // the MinIO browser — nothing downloaded it, so nothing wrote a manifest,
    // and demanding one stamped every correct upload MISSING forever. It is
    // verified by LISTING instead, which is also why it can never be PARTIAL:
    // PARTIAL means "the manifest and the bucket disagree", and this row owns
    // no manifest whose digest could drift.
    if (row.source === AiModelSource.LOCAL) {
      return measureByListing(row, keys, prefix);
    }

    const manifestKey = `${prefix}${MANIFEST_OBJECT}`;
    if (!keys.has(manifestKey)) {
      return { availability: AiModelAvailability.MISSING, detail: { reason: `${MANIFEST_OBJECT} not found under ${prefix}`, bucketPrefix: prefix } };
    }

    const bytes = await this.s3Service.getFile(HOPE_MODELS_BUCKET, manifestKey);
    const digest = sha256Hex(bytes);
    const summary = parseManifest(bytes);
    const missingObjects = summary.objects.filter((path) => !keys.has(`${prefix}${path}`));

    const detail: Record<string, unknown> = {
      bucketPrefix: prefix,
      manifestDigest: digest,
      objectsChecked: summary.objects.length,
      missingObjects,
      manifestDigestMismatch: row.manifestDigest !== null && row.manifestDigest !== undefined && row.manifestDigest !== digest,
    };

    if (missingObjects.length > 0 || detail.manifestDigestMismatch === true) {
      return { availability: AiModelAvailability.PARTIAL, detail };
    }

    // A row registered from the bucket carries no digest yet — adopt the one
    // just verified so the next run can detect drift.
    if (!row.manifestDigest) {
      row.manifestDigest = digest;
    }
    return { availability: AiModelAvailability.AVAILABLE, detail };
  }

  /**
   * TASK-1055 FU-3 — an HF-sourced row published into the HuggingFace cache tree (deployment repo
   * `out-of-band/hope-models-publish.yaml` §1): `refs/main` names the revision an offline name-only load
   * resolves, and its snapshot must hold files. `null` when `sourceUri` is not an `<org>/<repo>` id.
   */
  private async measureHfCache(
    row: AiModelEntity,
    keys: Set<string>,
  ): Promise<{ availability: AiModelAvailability; detail: Record<string, unknown> } | null> {
    const repo = (row.sourceUri ?? '').split('/');
    if (repo.length !== 2 || !repo[0] || !repo[1]) return null;
    const cacheDir = `${HF_HUB_ROOT}models--${repo[0]}--${repo[1]}/`;
    const refsMain = `${cacheDir}refs/main`;
    if (!keys.has(refsMain)) {
      return {
        availability: AiModelAvailability.MISSING,
        detail: { layout: 'hf-cache', reason: `not in the HF cache (${refsMain} not found) and no bucketPrefix` },
      };
    }

    let revision: string | null = null;
    try {
      revision = (await this.s3Service.getFile(HOPE_MODELS_BUCKET, refsMain)).toString('utf8').trim() || null;
    } catch (error) {
      this.logger.warn({
        message: 'HF cache refs/main unreadable; checking any snapshot',
        refsMain,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // The refs/main revision's snapshot, else any snapshot that holds files.
    const snapshotsRoot = `${cacheDir}snapshots/`;
    const bySnapshot = new Map<string, string[]>();
    for (const key of keys) {
      if (!key.startsWith(snapshotsRoot) || key.endsWith('/')) continue;
      const rest = key.slice(snapshotsRoot.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const rev = rest.slice(0, slash);
      bySnapshot.set(rev, [...(bySnapshot.get(rev) ?? []), rest.slice(slash + 1)]);
    }
    const chosen = revision && bySnapshot.has(revision) ? revision : ([...bySnapshot.keys()].sort()[0] ?? null);
    if (!chosen) {
      return {
        availability: AiModelAvailability.MISSING,
        detail: { layout: 'hf-cache', revision, reason: `${refsMain} exists but no snapshot under ${snapshotsRoot} holds files` },
      };
    }

    const files = bySnapshot.get(chosen) ?? [];
    const detail: Record<string, unknown> = {
      layout: 'hf-cache',
      revision: chosen,
      path: `${HOPE_MODELS_MOUNT.replace(/\/+$/, '')}/${snapshotsRoot}${chosen}`,
      objectsChecked: files.length,
    };
    const quant = (row.libraryName && GGML_QUANT_LIBRARIES.has(row.libraryName) ? (row.computeType ?? '') : '').toLowerCase();
    if (quant) {
      const candidates = ggmlCandidates(files);
      if (!candidates.some((path) => basename(path).toLowerCase().includes(quant))) {
        const seen = candidates.map(basename).join(', ') || 'none';
        return {
          availability: AiModelAvailability.MISSING,
          detail: { ...detail, reason: `no snapshot file matches quantization '${quant}' (files seen: ${seen})` },
        };
      }
    }
    return { availability: AiModelAvailability.AVAILABLE, detail };
  }

  /**
   * Every prefix in the bucket no catalogue row references, in two passes:
   *
   * - manifest-bearing (flat `<slug>/<version>/` or an HF-cache snapshot) —
   *   what the publisher itself wrote;
   * - manifest-LESS but weight-bearing ("staged") — what an admin uploaded.
   *
   * Before TASK-960 only the first pass existed, so the drawer discovered
   * exactly the prefixes that need no adopting and never the one that does.
   */
  private async findUnregisteredPrefixes(listed: BucketObject[], keys: Set<string>, referenced: Set<string>): Promise<UnregisteredBucketPrefix[]> {
    const result: UnregisteredBucketPrefix[] = [];
    for (const key of keys) {
      if (!key.endsWith(`/${MANIFEST_OBJECT}`)) continue;
      const prefix = key.slice(0, key.length - MANIFEST_OBJECT.length);
      if (referenced.has(prefix)) continue;
      if (!FLAT_PREFIX_RE.test(prefix) && !HF_SNAPSHOT_PREFIX_RE.test(prefix)) continue;

      let summary: ManifestSummary = { slug: null, version: null, objects: [], totalBytes: null };
      try {
        summary = parseManifest(await this.s3Service.getFile(HOPE_MODELS_BUCKET, key));
      } catch (error) {
        this.logger.warn({
          message: 'Unregistered prefix has an unreadable manifest',
          prefix,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const flat = prefix.match(FLAT_PREFIX_RE);
      result.push({
        bucketPrefix: prefix,
        layout: flat ? 'flat' : 'hf-cache',
        slug: summary.slug ?? (flat ? flat[1] : null),
        version: summary.version ?? (flat ? flat[2] : null),
        objectCount: summary.objects.length,
        totalBytes: summary.totalBytes,
      });
    }

    result.push(...findStagedPrefixes(listed, keys, referenced));
    return result.sort((a, b) => a.bucketPrefix.localeCompare(b.bucketPrefix));
  }
}

/**
 * The verdict for a LOCAL row: does the bucket actually hold what the row
 * points at? `primaryObject` is the single file a single-file loader opens, so
 * when it is set its presence IS the answer; otherwise any object under the
 * prefix is enough, since a directory loader reads the whole prefix.
 */
function measureByListing(
  row: AiModelEntity,
  keys: Set<string>,
  prefix: string,
): { availability: AiModelAvailability; detail: Record<string, unknown> } {
  const primaryObject = row.primaryObject ?? null;
  const objectsChecked = countObjectsUnder(keys, prefix);
  const detail: Record<string, unknown> = { bucketPrefix: prefix, primaryObject, objectsChecked, verifiedBy: 'listing' };

  if (primaryObject) {
    if (!keys.has(`${prefix}${primaryObject.replace(/^\/+/, '')}`)) {
      return {
        availability: AiModelAvailability.MISSING,
        detail: { ...detail, reason: `primaryObject ${primaryObject} not found under ${prefix}`, missingObjects: [primaryObject] },
      };
    }
    return { availability: AiModelAvailability.AVAILABLE, detail };
  }

  if (objectsChecked === 0) {
    return { availability: AiModelAvailability.MISSING, detail: { ...detail, reason: `no objects found under ${prefix}` } };
  }
  return { availability: AiModelAvailability.AVAILABLE, detail };
}

/** TASK-1055 FU-3 — LM Studio serves the row (its `servedBy` or `provider` says so). */
function isLmStudioRow(row: AiModelEntity): boolean {
  return LM_STUDIO_NAMES.has(row.servedBy ?? '') || LM_STUDIO_NAMES.has(row.provider ?? '');
}

/**
 * TASK-1055 FU-3 — an LM Studio row's GGUF on the serving tier: a top-level `<dir>/` the cluster's
 * `link-models` init container names after the row's LM Studio key (`lmStudioWireModelId`, the same
 * mapping: `-gguf` suffix and a `text-embedding-` prefix stripped).
 */
function measureGgufTier(row: AiModelEntity, keys: Set<string>): { availability: AiModelAvailability; detail: Record<string, unknown> } {
  const key = row.sourceUri ?? '';
  const dirs = new Set<string>();
  for (const object of keys) {
    const slash = object.indexOf('/');
    if (slash > 0 && slash < object.length - 1) dirs.add(object.slice(0, slash));
  }
  for (const dir of [...dirs].sort()) {
    if (!dir.endsWith('-gguf') || lmStudioWireModelId('lm-studio', dir, row.taskType) !== key) continue;
    const prefix = `${dir}/`;
    return { availability: AiModelAvailability.AVAILABLE, detail: { layout: 'gguf-tier', prefix, objectsChecked: countObjectsUnder(keys, prefix) } };
  }
  const expected = `${key.replace(/^text-embedding-/, '')}-gguf/`;
  return {
    availability: AiModelAvailability.MISSING,
    detail: { layout: 'gguf-tier', reason: `not on the LM Studio serving tier (no '${expected}' prefix in the bucket)` },
  };
}

/** The ggml weight files whisper.cpp would choose from (`_select_gguf_file`): `.gguf` / `.bin`, no AppleDouble sidecars, a `whisper.cpp/` subdirectory preferred. */
function ggmlCandidates(files: string[]): string[] {
  const candidates = files.filter((path) => /\.(gguf|bin)$/i.test(path) && !basename(path).startsWith('._')).sort();
  const subfolder = candidates.filter((path) => path.startsWith('whisper.cpp/') || path.includes('/whisper.cpp/'));
  return subfolder.length > 0 ? subfolder : candidates;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** How many objects the listing holds under `prefix` (the prefix marker aside). */
function countObjectsUnder(keys: Set<string>, prefix: string): number {
  let count = 0;
  for (const key of keys) {
    if (key !== prefix && key.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Manifest-less directories holding at least one weight file — an admin upload
 * through the MinIO browser, which is the only way a LOCAL model arrives.
 *
 * Objects are grouped by their containing directory rather than matched against
 * a shape, because a staged upload is routinely ONE segment deep
 * (`arcaai-whisper-en-2609/ggml-….bin`) and `FLAT_PREFIX_RE` requires two.
 */
function findStagedPrefixes(listed: BucketObject[], keys: Set<string>, referenced: Set<string>): UnregisteredBucketPrefix[] {
  const groups = new Map<string, { objectCount: number; bytes: number; sized: boolean; hasWeight: boolean }>();

  for (const item of listed) {
    const key = item.key;
    // A directory marker is not an object, and the HF cache is not adoptable.
    if (key.endsWith('/') || key.startsWith(HF_CACHE_ROOT)) continue;
    const slash = key.lastIndexOf('/');
    if (slash < 0) continue; // an object at the bucket root belongs to no prefix
    const dir = key.slice(0, slash + 1);

    const group = groups.get(dir) ?? { objectCount: 0, bytes: 0, sized: false, hasWeight: false };
    group.objectCount += 1;
    if (typeof item.size === 'number') {
      group.bytes += item.size;
      group.sized = true;
    }
    if (isModelWeightFile(key)) group.hasWeight = true;
    groups.set(dir, group);
  }

  const staged: UnregisteredBucketPrefix[] = [];
  for (const [dir, group] of groups) {
    if (!group.hasWeight) continue;
    if (isUnderKnownPrefix(dir, keys, referenced)) continue;
    const segments = dir.slice(0, -1).split('/');
    staged.push({
      bucketPrefix: dir,
      layout: 'staged',
      slug: segments[0] ?? null,
      version: segments.length === 2 ? segments[1] : null,
      objectCount: group.objectCount,
      totalBytes: group.sized ? group.bytes : null,
    });
  }
  return staged;
}

/**
 * Whether `dir`, or any prefix above it, is already published (carries a
 * manifest) or already registered. Without the ANCESTOR walk, every
 * subdirectory of a published model would be offered for registration.
 */
function isUnderKnownPrefix(dir: string, keys: Set<string>, referenced: Set<string>): boolean {
  const segments = dir.slice(0, -1).split('/');
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const ancestor = `${segments.slice(0, depth).join('/')}/`;
    if (referenced.has(ancestor)) return true;
    if (keys.has(`${ancestor}${MANIFEST_OBJECT}`)) return true;
  }
  return false;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function parseManifest(bytes: Buffer): ManifestSummary {
  const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const objects = Array.isArray(parsed.objects) ? (parsed.objects as Array<{ path?: unknown }>).map((o) => String(o.path ?? '')).filter(Boolean) : [];
  return {
    slug: typeof parsed.slug === 'string' ? parsed.slug : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    objects,
    totalBytes: typeof parsed.totalBytes === 'number' ? parsed.totalBytes : null,
  };
}
