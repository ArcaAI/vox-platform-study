import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiModelAvailability, AiModelEntity, AiModelRepository, CoreDatabaseService, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IS3Service } from '../../baseServices/storage';
import { HOPE_MODELS_BUCKET } from '../constants';
import { sha256Hex } from '../publish/model-version.util';
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

  constructor(
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
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

    return { checkedAt, counts, rows: verdicts, unregistered };
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
