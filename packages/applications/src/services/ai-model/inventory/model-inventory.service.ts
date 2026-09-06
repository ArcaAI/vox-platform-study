import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AiModelAvailability, AiModelEntity, AiModelRepository, CoreDatabaseService, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IS3Service } from '../../baseServices/storage';
import { IRedisCacheService } from '../../baseServices/redis';
import { IInferenceReadinessService } from '../../ai-readiness/IInferenceReadinessService';
import { HOPE_MODELS_BUCKET } from '../constants';
import { sha256Hex } from '../publish/model-version.util';
import { MODEL_INVENTORY_REPORT_KEY, MODEL_INVENTORY_REPORT_TTL_SECONDS } from './model-inventory.constants';
import type { ModelInventoryReport, ModelInventoryRow, UnregisteredBucketPrefix } from './dto';

/**
 * Libraries whose weights ship inside the Python package (nothing in the
 * bucket to inventory). Kept next to `HF_CACHE_LIBRARIES` in spirit; small
 * enough to live here.
 */
const WEIGHTLESS_LIBRARIES: ReadonlySet<string> = new Set(['pyrnnoise', 'deepfilternet']);

const MANIFEST_OBJECT = 'manifest.json';
const FLAT_PREFIX_RE = /^([^/]+)\/([^/]+)\/$/;
const HF_SNAPSHOT_PREFIX_RE = /^hf\/hub\/models--[^/]+\/snapshots\/[^/]+\/$/;

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
  ) {}

  async runInventory(): Promise<ModelInventoryReport> {
    const checkedAt = new Date();

    // ONE listing — a bucket read error is surfaced, never turned into a
    // false MISSING on every row.
    const listed = (await this.s3Service.listFiles(HOPE_MODELS_BUCKET, '')) as Array<{ key: string; size?: number }>;
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

    const unregistered = await this.findUnregisteredPrefixes(keys, referencedPrefixes);

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
      return { availability: AiModelAvailability.MISSING, detail: { reason: 'no bucketPrefix — the row has never been published' } };
    }

    const prefix = normalizePrefix(row.bucketPrefix);
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
   * Every manifest-bearing prefix in the bucket (flat `<slug>/<version>/` or
   * an HF-cache snapshot) that no catalogue row references.
   */
  private async findUnregisteredPrefixes(keys: Set<string>, referenced: Set<string>): Promise<UnregisteredBucketPrefix[]> {
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
    return result.sort((a, b) => a.bucketPrefix.localeCompare(b.bucketPrefix));
  }
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
